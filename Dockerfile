FROM node:20

# Python, ffmpeg, yt-dlp kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir yt-dlp --break-system-packages && \
    curl -fsSL https://deno.land/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno PATH'e ekle — yt-dlp bunu JavaScript runtime olarak kullanacak
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

# yt-dlp'nin Deno'yu JS runtime olarak otomatik kullanması için
ENV YT_DLP_JAVASCRIPT_RUNTIME="deno"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD ["node","server.js"]