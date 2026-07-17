#!/bin/bash
set -e

echo "=== Updating package list ==="
sudo apt update

echo "=== Installing Node.js, npm, Python, FFmpeg, and Curl ==="
sudo apt install -y nodejs npm python3 ffmpeg curl

echo "=== Installing the latest yt-dlp binary from GitHub ==="
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

echo "=== Verifying yt-dlp installation ==="
yt-dlp --version

echo "=== Installing backend Node.js dependencies ==="
cd ~/backend
npm install

echo "=== Setup complete! ==="
echo "You can now run: node index.js"
