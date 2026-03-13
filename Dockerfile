FROM node:20

# Python ve ffmpeg kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    ln -s /usr/bin/python3 /usr/bin/python

# yt-dlp sabitle
RUN pip3 install --break-system-packages yt-dlp==2025.02.19

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 5000

CMD ["node","server.js"]