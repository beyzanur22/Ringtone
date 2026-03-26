FROM node:20

# System dependencies: Python, ffmpeg, curl
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv ffmpeg curl && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# yt-dlp + PoToken provider plugin
RUN pip3 install --no-cache-dir --break-system-packages \
      yt-dlp \
      bgutil-ytdlp-pot-provider

# PoToken HTTP Server — npm global ile kur (binary download yerine daha güvenilir)
RUN npm install -g bgutil-ytdlp-pot-provider || true

# yt-dlp güncelle
RUN yt-dlp --update || true

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Cache dizini
RUN mkdir -p /app/cache /app/yt_cache

# Entrypoint'u çalıştırılabilir yap
RUN chmod +x /app/entrypoint.sh 2>/dev/null || true

EXPOSE 5000

CMD ["bash", "/app/entrypoint.sh"]