#!/bin/bash
set -e

echo "🔑 PoToken Server başlatılıyor (port 4416)..."

# Global paketi veya npx'i kullanarak başlat
if command -v bgutil-ytdlp-pot-provider &> /dev/null; then
  bgutil-ytdlp-pot-provider --port 4416 &
  POT_PID=$!
  echo "✅ PoToken Server başlatıldı (PID: $POT_PID)"
else
  npx bgutil-ytdlp-pot-provider --port 4416 &
  POT_PID=$!
  echo "✅ PoToken Server başlatıldı (npx PID: $POT_PID)"
fi

sleep 5

# PoToken server kontrolü
if kill -0 $POT_PID 2>/dev/null; then
  echo "✅ PoToken Server aktif ve çalışıyor"
else
  echo "⚠️ PoToken Server başlatılamadı veya durdu. Loglar kontrol edilmeli."
fi

echo "🎵 Node.js uygulaması başlatılıyor..."
exec node server.js
