#!/bin/bash

# PoToken HTTP sunucusunu arka planda başlat (port 4416)
echo "[STARTUP] PoToken sunucusu başlatılıyor (port 4416)..."
python3 -m bgutil_ytdlp_pot_provider serve &
POT_PID=$!

# Sunucunun başlamasını bekle
sleep 3

# Sunucu çalışıyor mu kontrol et
if kill -0 $POT_PID 2>/dev/null; then
    echo "[STARTUP] PoToken sunucusu başarıyla başlatıldı (PID: $POT_PID)"
else
    echo "[STARTUP] UYARI: PoToken sunucusu başlatılamadı"
fi

# yt-dlp challenge solver script'ini indir (Deno ile)
echo "[STARTUP] yt-dlp JS challenge solver indiriliyor..."
yt-dlp --remote-components ejs:github --version 2>/dev/null || true

# Node.js sunucusunu başlat
echo "[STARTUP] Node.js sunucusu başlatılıyor..."
exec node server.js
