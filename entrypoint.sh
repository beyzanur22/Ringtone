#!/bin/bash
set -e

echo "🔑 PoToken Server başlatılıyor (port 4416)..."

# bgutil-ytdlp-pot-provider HTTP server'ı arka planda çalıştır
# Önce npx ile dene, sonra global kurulumu
if command -v bgutil-ytdlp-pot-provider &> /dev/null; then
  bgutil-ytdlp-pot-provider --port 4416 &
  POT_PID=$!
  echo "✅ PoToken Server PID: $POT_PID (global)"
  sleep 2
elif npx bgutil-ytdlp-pot-provider --port 4416 &> /dev/null & then
  POT_PID=$!
  echo "✅ PoToken Server PID: $POT_PID (npx)"
  sleep 3
else
  echo "⚠️ PoToken server başlatılamadı — tv_embedded/android_vr client'larla devam ediliyor"
fi

# PoToken server kontrolü
if [ ! -z "$POT_PID" ]; then
  if kill -0 $POT_PID 2>/dev/null; then
    echo "✅ PoToken Server çalışıyor"
  else
    echo "⚠️ PoToken Server başlatıldı ama kapandı"
  fi
fi

echo "🎵 Node.js uygulaması başlatılıyor..."
exec node server.js
