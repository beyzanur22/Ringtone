#!/bin/bash

# PoToken HTTP sunucusunu arka planda başlat (port 4416)
echo "[STARTUP] PoToken sunucusu başlatılıyor (port 4416)..."
bgutil-ytdlp-pot-provider serve &
POT_PID=$!

# Sunucunun başlamasını bekle
sleep 2

# Sunucu çalışıyor mu kontrol et
if kill -0 $POT_PID 2>/dev/null; then
    echo "[STARTUP] PoToken sunucusu başarıyla başlatıldı (PID: $POT_PID)"
else
    echo "[STARTUP] UYARI: PoToken sunucusu başlatılamadı, yt-dlp PoToken olmadan çalışacak"
fi

# Node.js sunucusunu başlat
echo "[STARTUP] Node.js sunucusu başlatılıyor..."
exec node server.js
