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
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8787;
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim());

// ---------------------------------------------------------------------
// YouTube cookies (fixes "Sign in to confirm you're not a bot")
// ---------------------------------------------------------------------
// YouTube increasingly blocks anonymous/datacenter IPs (which is exactly
// what a Railway box looks like to them) unless yt-dlp presents cookies
// from a real, logged-in browser session. Set the env var
// YTDLP_COOKIES_B64 to the base64-encoded contents of a cookies.txt file
// (Netscape format) exported from your own browser, and this decodes it
// once at boot into a temp file that every yt-dlp call below points to.
// If the env var isn't set, yt-dlp just runs without cookies as before.
let COOKIES_FILE_PATH = null;
if (process.env.YTDLP_COOKIES_B64) {
  try {
    const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8');
    COOKIES_FILE_PATH = path.join(os.tmpdir(), 'yt-dlp-cookies.txt');
    fs.writeFileSync(COOKIES_FILE_PATH, decoded, { mode: 0o600 });
    console.log('[startup] Loaded YouTube cookies from YTDLP_COOKIES_B64.');
  } catch (err) {
    console.error('[startup] Failed to decode YTDLP_COOKIES_B64:', err.message);
    COOKIES_FILE_PATH = null;
  }
} else {
  console.warn('[startup] YTDLP_COOKIES_B64 not set - YouTube requests may be blocked with "Sign in to confirm you\'re not a bot".');
}

// Helper: prepend --cookies <path> and a player-client fallback to a
// yt-dlp args array. YouTube has been requiring extra verification
// (a "PO token") for its default web client; the "tv" client generally
// still works without one and pairs well with cookies. Combining both
// is currently the most reliable combo the yt-dlp community has found.
function withCookies(args) {
  const extra = ['--extractor-args', 'youtube:player_client=android,tv,web'];
  const withClient = [...extra, ...args];
  return COOKIES_FILE_PATH ? ['--cookies', COOKIES_FILE_PATH, ...withClient] : withClient;
}

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
      withCookies(args),
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
  // YouTube (and others) serve the *same* resolution in multiple codecs
  // (av1/vp9/h264), which used to show up as several near-identical rows
  // like "1080p (94MB)" and "1080p (40MB)". Instead: bucket by resolution,
  // keep only the single best variant per bucket, and offer one clean
  // audio (MP3) option - same short list style as most downloader sites.
  const videoByHeight = new Map();
  const audioCandidates = [];

  for (const f of rawFormats) {
    if (!f.url) continue; // skip formats yt-dlp can't hand us a direct URL for
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (!hasVideo && !hasAudio) continue;

    if (hasVideo) {
      const height = f.height || 0;
      if (!height) continue; // skip formats with no usable resolution info

      // Prefer higher bitrate, higher fps, and widely-compatible h264/avc1
      const score =
        (f.tbr || 0) +
        (f.fps && f.fps > 30 ? 500 : 0) +
        (f.vcodec && f.vcodec.startsWith('avc1') ? 250 : 0);

      const existing = videoByHeight.get(height);
      if (!existing || score > existing._score) {
        videoByHeight.set(height, { ...f, _score: score });
      }
    } else {
      audioCandidates.push(f);
    }
  }

  const videoFormats = Array.from(videoByHeight.values())
    .sort((a, b) => b.height - a.height)
    .slice(0, 6) // top 6 resolutions is plenty; avoids an endless list
    .map((f) => {
      const label =
        f.height >= 2160
          ? `4K (${f.height}p)`
          : `${f.height}p${f.fps && f.fps > 30 ? ` ${f.fps}fps` : ''}`;

      // Video-only streams still need an audio track merged in at
      // download time; combined streams can be fetched as-is.
      const downloadSelector =
        f.acodec && f.acodec !== 'none' ? f.format_id : `${f.format_id}+bestaudio/best`;

      return {
        formatId: downloadSelector,
        label,
        ext: 'mp4',
        kind: 'video',
        hasAudio: true,
        width: f.width || null,
        height: f.height || null,
        filesize: f.filesize || f.filesize_approx || null,
      };
    });

  // One clean audio option, converted to MP3 at download time regardless
  // of the source codec (opus/m4a/etc) - so we only ever show a single
  // "MP3 Audio" row instead of several raw-codec/bitrate variants.
  audioCandidates.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const bestAudio = audioCandidates[0];
  const audioFormats = bestAudio
    ? [
        {
          formatId: bestAudio.format_id,
          label: 'MP3 Audio',
          ext: 'mp3',
          kind: 'audio',
          hasAudio: true,
          width: null,
          height: null,
          filesize: bestAudio.filesize || bestAudio.filesize_approx || null,
        },
      ]
    : [];

  return [...videoFormats, ...audioFormats];
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

    const yt = spawn(YTDLP_PATH, withCookies(ytArgs));
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
    // Video: yt-dlp downloads video+audio, merges them with ffmpeg, and
    // streams the result straight to the browser as it's produced - no
    // waiting for a full file to finish writing to disk first.
    //
    // Two things had to be true at once to make this safe:
    //  1. Audio must always be AAC (not copied as-is), because YouTube's
    //     separate audio track is usually Opus, and most standard video
    //     players can't decode Opus inside mp4 - only ffmpeg-based apps
    //     (Clipchamp, VLC) can. So we force -c:a aac.
    //  2. A plain mp4 mux needs to SEEK BACK at the end to write its
    //     index (the "moov atom") - impossible on a stdout pipe. Without
    //     handling this, ffmpeg either fails or drops the audio track
    //     entirely on a pipe. The fix is fragmented mp4
    //     (frag_keyframe+empty_moov), which writes the index incrementally
    //     instead of seeking back, so it works perfectly over a pipe -
    //     the resulting file is still a completely standard, fully
    //     playable mp4 once downloaded.
    const ytArgs = [
      '-f', formatId || 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--postprocessor-args',
      'Merger:-c:v copy -c:a aac -b:a 192k -movflags frag_keyframe+empty_moov+default_base_moof',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      url,
    ];

    const yt = spawn(YTDLP_PATH, withCookies(ytArgs));
    let stderrTail = '';

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp4"`);

    yt.stdout.pipe(res);
    yt.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      console.error('[yt-dlp]', s);
    });
    yt.on('error', (err) => {
      cleanup(yt);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to start yt-dlp.', detail: err.message });
    });
    yt.on('exit', (code) => {
      if (killed) return;
      if (code !== 0 && !res.headersSent) {
        const msg = stderrTail.split('\n').filter(Boolean).pop() || 'yt-dlp exited with an error.';
        res.status(502).json({ error: 'Download failed.', detail: msg });
      }
    });
    req.on('close', () => cleanup(yt));
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Tap2Save backend listening on http://localhost:${PORT}`);
});
