#!/bin/bash

# Port 4416'yı temizle (eğer önceden kalmışsa)
fuser -k 4416/tcp 2>/dev/null || true

# PoToken HTTP sunucusunu başlat ve loglarını dosyaya yaz
echo "[STARTUP] PoToken sunucusu başlatılıyor (port 4416)..."
nohup python3 -m bgutil_ytdlp_pot_provider serve --port 4416 > pot_server.log 2>&1 &
POT_PID=$!

# Sunucunun başlamasını bekle ve ping atarak kontrol et
echo "[STARTUP] Sunucunun hazır olması bekleniyor..."
for i in {1..10}; do
    if curl -s http://127.0.0.1:4416/ping > /dev/null; then
        echo "[STARTUP] PoToken sunucusu HAZIR (Ping OK)"
        break
    fi
    echo "[STARTUP] Bekleniyor... ($i/10)"
    sleep 2
done

# Sunucu hala çalışıyor mu?
if kill -0 $POT_PID 2>/dev/null; then
    echo "[STARTUP] PoToken sunucusu arka planda çalışıyor (PID: $POT_PID)"
else
    echo "[STARTUP] HATA: PoToken sunucusu çöktü! Loglar:"
    cat pot_server.log
fi

# JS çözücüleri önceden indir
echo "[STARTUP] yt-dlp JS çözücüler güncelleniyor..."
yt-dlp --remote-components ejs:github --version || true

# Node.js'i başlat
echo "[STARTUP] Node.js sunucusu başlatılıyor..."
exec node server.js
