#!/bin/bash
set -e

export PATH=$PATH:/usr/local/bin:/root/.local/bin

echo "🔑 PoToken Server başlatılıyor (port 4416)..."

# Xvfb sanal ekran başlat (arkada)
Xvfb :99 -screen 0 1024x768x16 &
export DISPLAY=:99

# PoToken server'ı doğru komutla başlat
POT_BIN=$(find /usr /root /home -name "bgutil-ytdlp-pot-provider" -type f -executable 2>/dev/null | head -n 1)

if [ -z "$POT_BIN" ]; then
  echo "⚠️ DİKKAT: bgutil-ytdlp-pot-provider binary bulunamadı! PoToken'sız başlanıyor."
  export POTOKEN_AVAILABLE=false
else
  echo "🔑 PoToken binary bulundu: $POT_BIN"
  $POT_BIN server --port 4416 > /app/potoken.log 2>&1 &
  POT_PID=$!
  echo "✅ PoToken Server başlatıldı (PID: $POT_PID)"

  sleep 10

  # PoToken server kontrolü
  if kill -0 $POT_PID 2>/dev/null; then
    echo "✅ PoToken Server aktif ve çalışıyor"
    export POTOKEN_AVAILABLE=true
  else
    echo "⚠️ PoToken Server başlatılamadı veya durdu. Loglar:"
    tail -n 20 /app/potoken.log 2>/dev/null || true
    
    # İkinci deneme
    echo "🔄 PoToken Server ikinci kez deneniyor..."
    $POT_BIN server --port 4416 > /app/potoken.log 2>&1 &
    POT_PID=$!
    sleep 5
    if kill -0 $POT_PID 2>/dev/null; then
      echo "✅ PoToken Server ikinci denemede başarılı!"
      export POTOKEN_AVAILABLE=true
    else
      echo "⚠️ PoToken Server başlatılamadı — PoToken'sız devam ediliyor"
      export POTOKEN_AVAILABLE=false
    fi
  fi
fi

echo "🎵 Node.js uygulaması başlatılıyor..."
exec node server.js
