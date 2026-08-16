FROM node:20-slim

# ffmpeg (for merging video+audio and mp3 conversion) + python3/pip (to install yt-dlp)
# We key the cache-bust off Railway's auto-injected git commit SHA instead of
# a static number. A hardcoded ARG value (e.g. CACHEBUST=1) never changes
# between builds, so Docker just reuses the very first cached layer forever -
# "pip3 install -U yt-dlp" then only ever actually runs ONCE, on the
# first-ever build, silently going stale on every deploy after that even
# though the command looks like it updates. Since RAILWAY_GIT_COMMIT_SHA is
# different on every push, referencing it inside the RUN command forces a
# real cache miss (and therefore a real yt-dlp update) on every deploy.
# YouTube's bot-detection/page-structure changes fast enough that this
# matters a lot - see the "Failed to extract any player response... update
# yt-dlp" error class, which is yt-dlp's own way of reporting it's stale.
ARG RAILWAY_GIT_COMMIT_SHA=unknown
RUN echo "cachebust: ${RAILWAY_GIT_COMMIT_SHA}" && \
    apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates && \
    pip3 install --no-cache-dir --break-system-packages -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
