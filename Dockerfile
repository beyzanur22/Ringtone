FROM node:20

# Python, ffmpeg ve yt-dlp + PoToken plugin kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp bgutil-ytdlp-pot-provider && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD ["node","server.js"]