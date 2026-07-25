FROM node:20

# Python, ffmpeg, yt-dlp + PoToken plugin kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp bgutil-ytdlp-pot-provider && \
    curl -fsSL https://deno.land/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# PM2 kur (çökme koruması, otomatik restart)
RUN npm install -g pm2

# Deno PATH'e ekle
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

WORKDIR /app

# Kalıcı dizinleri oluştur
RUN mkdir -p /app/media/audio /app/media/mp3 /app/media/video /app/media/thumbs /app/media/temp /app/cache /app/logs

COPY package*.json ./
RUN npm install --production

COPY . .

# Başlatma scripti
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 5000

# PM2 ile başlat (çökme koruması + log yönetimi)
CMD ["pm2-runtime", "ecosystem.config.js"]
