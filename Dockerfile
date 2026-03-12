FROM node:20

# Python ve ffmpeg kur
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 5000

CMD ["node","server.js"]