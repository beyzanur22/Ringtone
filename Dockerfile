FROM jim60105/yt-dlp:pot AS pot-provider

FROM node:20

# PoToken-destekli yt-dlp'yi kopyala
COPY --from=pot-provider /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

# Python ve ffmpeg kur
RUN apt-get update && \
    apt-get install -y python3 ffmpeg && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD ["node","server.js"]