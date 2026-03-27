FROM node:20

# Python, ffmpeg, Deno (JS runtime), yt-dlp + PoToken plugin kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp bgutil-ytdlp-pot-provider && \
    curl -fsSL https://deno.land/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno PATH'e ekle
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Başlatma scripti: önce PoToken sunucusu, sonra Node.js
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 5000

CMD ["/app/start.sh"]