FROM node:20

# Python, ffmpeg, yt-dlp ve deno (JS runtime) kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir yt-dlp --break-system-packages && \
    curl -fsSL https://deno.land/install.sh | sh

# Deno PATH'e ekle
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 5000

CMD ["node","server.js"]