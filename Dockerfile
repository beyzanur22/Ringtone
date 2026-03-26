FROM node:20

# Python, ffmpeg, yt-dlp + PoToken plugin kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv ffmpeg curl && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir --break-system-packages \
      yt-dlp \
      bgutil-ytdlp-pot-provider && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# yt-dlp'yi güncelle (en güncel versiyon)
RUN yt-dlp --update || true

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Cache dizini
RUN mkdir -p /app/cache /app/yt_cache

EXPOSE 5000

CMD ["node","server.js"]