FROM node:20

# System dependencies: Python, ffmpeg, curl, Chromium and Puppeteer libs
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv ffmpeg curl xvfb \
    chromium libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2 libpangocairo-1.0-0 libpango-1.0-0 && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# yt-dlp + PoToken provider plugin
RUN pip3 install --no-cache-dir --break-system-packages \
      yt-dlp \
      bgutil-ytdlp-pot-provider

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