FROM node:20-slim

# ffmpeg (for merging video+audio and mp3 conversion) + python3/pip (to install yt-dlp)
RUN apt-get update && \
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
