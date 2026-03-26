#!/bin/bash
set -e

export PATH=$PATH:/usr/local/bin:/root/.local/bin

echo "🔑 PoToken Server başlatılıyor (port 4416)..."

# Xvfb sanal ekran başlat (arkada)
Xvfb :99 -screen 0 1024x768x16 &
export DISPLAY=:99

# PoToken server'ı doğru komutla başlat ve logları dosyaya yaz
bgutil-ytdlp-pot-provider server --port 4416 > /app/potoken.log 2>&1 &
POT_PID=$!
echo "✅ PoToken Server başlatıldı (PID: $POT_PID)"

sleep 10

# PoToken server kontrolü
if kill -0 $POT_PID 2>/dev/null; then
  echo "✅ PoToken Server aktif ve çalışıyor"
else
  echo "⚠️ PoToken Server ÇÖKTÜ! Son 20 satır log:"
  tail -n 20 /app/potoken.log
fi

echo "🎵 Node.js uygulaması başlatılıyor..."
exec node server.js
