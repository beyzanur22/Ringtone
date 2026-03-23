FROM node:20

# Python, ffmpeg ve yt-dlp kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --no-cache-dir yt-dlp --break-system-packages

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 5000

CMD ["node","server.js"]