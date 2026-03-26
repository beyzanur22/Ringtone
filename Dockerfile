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

# PoToken HTTP Server kurulumu (Rust binary — tek dosya, hızlı)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      curl -fsSL -o /usr/local/bin/pot-server \
        "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/pot_provider-linux-x64" && \
      chmod +x /usr/local/bin/pot-server; \
    elif [ "$ARCH" = "arm64" ]; then \
      curl -fsSL -o /usr/local/bin/pot-server \
        "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/pot_provider-linux-arm64" && \
      chmod +x /usr/local/bin/pot-server; \
    else \
      echo "PoToken server: unsupported arch $ARCH"; \
    fi

# yt-dlp güncellemesi
RUN yt-dlp --update || true

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Cache dizini
RUN mkdir -p /app/cache /app/yt_cache

# Entrypoint dosyasını çalıştırılabilir yap
RUN chmod +x /app/entrypoint.sh 2>/dev/null || true

EXPOSE 5000

# PoToken server + Node.js birlikte başlat
CMD ["bash", "/app/entrypoint.sh"]