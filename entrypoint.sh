#!/bin/bash
set -e

echo "🔑 PoToken Server başlatılıyor (port 4416)..."

# bgutil-ytdlp-pot-provider HTTP server'ı arka planda çalıştır
# Bu server, yt-dlp plugin'inin PoToken üretmesi için gerekli
if command -v bgutil-provider &> /dev/null; then
  bgutil-provider --port 4416 &
  POT_PID=$!
  echo "✅ PoToken Server PID: $POT_PID"
  sleep 2
elif [ -f "/usr/local/bin/generate_token_server" ]; then
  /usr/local/bin/generate_token_server --port 4416 &
  POT_PID=$!
  echo "✅ PoToken Server PID: $POT_PID"
  sleep 2
else
  echo "⚠️ PoToken server bulunamadı, yt-dlp PoToken olmadan çalışacak"
fi

echo "🎵 Node.js uygulaması başlatılıyor..."
exec node server.js
