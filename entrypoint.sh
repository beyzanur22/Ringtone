#!/bin/bash
set -e

export PATH=$PATH:/usr/local/bin:/root/.local/bin

echo "🔑 PoToken Server başlatılıyor (port 4416)..."

# Python modülü olarak 'server' komutuyla başlat
# Browser işlemleri için xvfb-run kullanıyoruz
xvfb-run -a python3 -m bgutil_ytdlp_pot_provider server --port 4416 &
POT_PID=$!
echo "✅ PoToken Server başlatıldı (PID: $POT_PID)"

sleep 8

# PoToken server kontrolü
if kill -0 $POT_PID 2>/dev/null; then
  echo "✅ PoToken Server aktif ve çalışıyor"
else
  echo "⚠️ PoToken Server başlatılamadı veya durdu. Loglar kontrol edilmeli."
fi

echo "🎵 Node.js uygulaması başlatılıyor..."
exec node server.js
