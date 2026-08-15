FROM node:20-slim

# ffmpeg (for merging video+audio and mp3 conversion), python3/pip (to
# install yt-dlp), and Deno (a JavaScript runtime yt-dlp now needs to
# solve the "signature"/"n" challenges YouTube throws at every request -
# without it, YouTube serves formats with no usable download URL at all,
# which is why extraction was failing with "Requested format is not
# available" even though everything else was configured correctly).
# ARG CACHEBUST forces this layer to always rerun on every build, instead of
# reusing Docker's cached layer from the first-ever build. Without this,
# "pip3 install -U yt-dlp" only actually updates once - on every deploy
# after that, Docker sees this line hasn't changed and just reuses the
# OLD cached yt-dlp version, silently defeating the -U flag. YouTube's
# bot-detection changes fast enough that this matters a lot.
ARG CACHEBUST=1
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates curl unzip && \
    pip3 install --no-cache-dir --break-system-packages -U yt-dlp && \
    curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
