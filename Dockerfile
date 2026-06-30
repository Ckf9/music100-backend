FROM node:20-slim

# Install python3, ffmpeg, and curl
RUN apt-get update && \
    apt-get install -y python3 ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

# Fetch yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

EXPOSE 3000

CMD [ "node", "index.js" ]
