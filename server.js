/**
 * Tap2Save.net backend
 * -----------------------------------------------------------------------
 * Provides two endpoints the frontend can call instead of its demo/sample
 * data:
 *
 *   POST /api/info       -> resolve a video URL into title/thumbnail/
 *                            duration/available formats
 *   GET  /api/download    -> streams the actual video/audio file back to
 *                            the browser (never saved to disk on the
 *                            server - piped straight through)
 *
 * Extraction is done with yt-dlp (https://github.com/yt-dlp/yt-dlp), the
 * actively-maintained, open-source tool that already understands
 * YouTube, Instagram, TikTok, Twitter/X, Facebook and hundreds of other
 * sites. This server is a thin, safer HTTP wrapper around it - it does
 * not reimplement any site-specific extraction logic itself.
 *
 * REQUIREMENTS ON THE HOST MACHINE (see README.md):
 *   - Node.js 18+
 *   - yt-dlp on PATH        (pip install -U yt-dlp)
 *   - ffmpeg on PATH        (needed to merge video+audio / make mp3)
 *
 * IMPORTANT: only use this to download content you have the right to
 * download (your own uploads, content explicitly licensed for reuse,
 * etc). Downloading other people's videos from these platforms without
 * permission generally violates their Terms of Service.
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8787;
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim());

app.use(express.json({ limit: '32kb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
  })
);

// ---------------------------------------------------------------------
// Basic abuse protection
// ---------------------------------------------------------------------
const infoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 metadata lookups / minute / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 downloads / minute / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many downloads. Please slow down and try again shortly.' },
});

// ---------------------------------------------------------------------
// URL validation - restrict to the platforms the frontend advertises
// ---------------------------------------------------------------------
const SUPPORTED_HOST_PATTERNS = [
  /(^|\.)youtube\.com$/i,
  /^youtu\.be$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)facebook\.com$/i,
  /^fb\.watch$/i,
];

function isSupportedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    return SUPPORTED_HOST_PATTERNS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function detectPlatform(rawUrl) {
  const host = new URL(rawUrl).hostname.replace(/^www\./, '');
  if (host.includes('youtube') || host === 'youtu.be') return 'YouTube';
  if (host.includes('instagram')) return 'Instagram';
  if (host.includes('tiktok')) return 'TikTok';
  if (host.includes('twitter') || host === 'x.com') return 'Twitter/X';
  if (host.includes('facebook') || host === 'fb.watch') return 'Facebook';
  return 'Unknown';
}

// ---------------------------------------------------------------------
// Helper: run `yt-dlp --dump-single-json <url>` and parse the result
// ---------------------------------------------------------------------
function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      '--socket-timeout', '20',
      url,
    ];

    execFile(
      YTDLP_PATH,
      args,
      { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.toString().split('\n').filter(Boolean).pop() || err.message;
          return reject(new Error(msg));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(new Error('Failed to parse yt-dlp output'));
        }
      }
    );
  });
}

function simplifyFormats(rawFormats = []) {
  // Keep only formats that are actually downloadable and useful to show,
  // collapse to a friendly shape, and dedupe by resolution+ext.
  const seen = new Set();
  const formats = [];

  for (const f of rawFormats) {
    if (!f.url) continue; // skip formats yt-dlp can't hand us a direct URL for
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (!hasVideo && !hasAudio) continue;

    const label = hasVideo
      ? `${f.height ? f.height + 'p' : f.format_note || 'video'}${f.fps ? ` ${f.fps}fps` : ''}`
      : `Audio ${f.abr ? Math.round(f.abr) + 'kbps' : ''}`.trim();

    const key = `${label}-${f.ext}-${hasVideo}-${hasAudio}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Many adaptive formats (esp. YouTube 720p+) ship video-only, with
    // audio as a separate track. If we handed the raw format_id straight
    // to the download step, yt-dlp would fetch video with no sound. Bake
    // the merge selector in now so /api/download always gets audio.
    const downloadSelector =
      hasVideo && !hasAudio ? `${f.format_id}+bestaudio/best` : f.format_id;

    formats.push({
      formatId: downloadSelector,
      label,
      ext: f.ext,
      kind: hasVideo ? 'video' : 'audio',
      hasAudio: hasVideo ? true : hasAudio, // true post-merge for video entries
      width: f.width || null,
      height: f.height || null,
      filesize: f.filesize || f.filesize_approx || null,
    });
  }

  // Sort video formats tallest first, audio formats highest bitrate first
  formats.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
    return (b.height || 0) - (a.height || 0);
  });

  return formats;
}

// ---------------------------------------------------------------------
// POST /api/info
// body: { url: string }
// ---------------------------------------------------------------------
app.post('/api/info', infoLimiter, async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }
  if (!isSupportedUrl(url)) {
    return res.status(400).json({ error: 'Unsupported or invalid video URL.' });
  }

  try {
    const meta = await fetchMetadata(url);

    const formats = simplifyFormats(meta.formats);
    const bestVideo = formats.find((f) => f.kind === 'video') || null;
    const bestAudio = formats.find((f) => f.kind === 'audio') || null;

    res.json({
      id: crypto.randomUUID(),
      originalUrl: url,
      platform: detectPlatform(url),
      title: meta.title || 'Untitled video',
      thumbnailUrl: meta.thumbnail || null,
      durationSeconds: meta.duration || null,
      uploader: meta.uploader || meta.channel || null,
      formats,
      recommended: {
        video: bestVideo?.formatId || null,
        audio: bestAudio?.formatId || null,
      },
    });
  } catch (err) {
    console.error('[info] extraction failed:', err.message);
    res.status(502).json({
      error: 'Could not fetch video info. The link may be private, region-locked, or unsupported.',
      detail: err.message,
    });
  }
});

// ---------------------------------------------------------------------
// GET /api/download
// query: url, formatId (optional), type=video|audio (default video)
// Streams the file straight through to the client - nothing is written
// to disk on the server.
// ---------------------------------------------------------------------
app.get('/api/download', downloadLimiter, (req, res) => {
  const { url, formatId, type = 'video', filename } = req.query;

  if (!url || typeof url !== 'string' || !isSupportedUrl(url)) {
    return res.status(400).json({ error: 'Missing or unsupported "url" query param.' });
  }

  const safeName = (filename || 'tap2save-video')
    .toString()
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    .slice(0, 120);

  let killed = false;
  const cleanup = (...procs) => {
    if (killed) return;
    killed = true;
    procs.forEach((p) => p && !p.killed && p.kill('SIGKILL'));
  };

  if (type === 'audio') {
    // yt-dlp -> stdout (best audio track) piped into ffmpeg -> mp3 -> stdout
    const ytArgs = [
      '-f', formatId || 'bestaudio/best',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      url,
    ];
    const ffArgs = ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-f', 'mp3', 'pipe:1'];

    const yt = spawn(YTDLP_PATH, ytArgs);
    const ff = spawn(FFMPEG_PATH, ffArgs);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp3"`);

    yt.stdout.pipe(ff.stdin);
    ff.stdout.pipe(res);

    yt.stderr.on('data', (d) => console.error('[yt-dlp]', d.toString()));
    ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString()));

    yt.on('error', () => { cleanup(yt, ff); if (!res.headersSent) res.sendStatus(500); });
    ff.on('error', () => { cleanup(yt, ff); if (!res.headersSent) res.sendStatus(500); });
    req.on('close', () => cleanup(yt, ff));
  } else {
    // Video: let yt-dlp select/merge the requested format and write
    // straight to stdout as mp4.
    const ytArgs = [
      '-f', formatId || 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      url,
    ];

    const yt = spawn(YTDLP_PATH, ytArgs);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp4"`);

    yt.stdout.pipe(res);
    yt.stderr.on('data', (d) => console.error('[yt-dlp]', d.toString()));
    yt.on('error', () => { cleanup(yt); if (!res.headersSent) res.sendStatus(500); });
    req.on('close', () => cleanup(yt));
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Tap2Save backend listening on http://localhost:${PORT}`);
});
