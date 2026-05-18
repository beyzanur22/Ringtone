#!/bin/bash

# === KENDI SUNUCUMUZ (173.212.249.105) ===
# Railway'den ayrıldık — cache artık silinmez, kalıcıdır

# Gerekli dizinleri oluştur (ilk kurulumda)
mkdir -p /app/cache
mkdir -p /app/media/audio
mkdir -p /app/media/mp3
mkdir -p /app/media/video
mkdir -p /app/media/thumbs
mkdir -p /app/media/temp

# Sadece temp klasörünü temizle (yarım kalmış indirmeler)
echo "[STARTUP] Temp dosyaları temizleniyor..."
rm -rf /app/media/temp/*

# JS çözücüleri güncelle
echo "[STARTUP] yt-dlp JS çözücüler güncelleniyor..."
yt-dlp --remote-components ejs:github --version || true

# yt-dlp'yi güncelle (en son anti-bot bypass'ları için)
echo "[STARTUP] yt-dlp güncelleniyor..."
pip3 install --upgrade --break-system-packages yt-dlp 2>/dev/null || true

# Disk kullanımı raporu
echo "[STARTUP] Disk kullanımı:"
du -sh /app/media/ 2>/dev/null || true
du -sh /app/cache/ 2>/dev/null || true

# Node.js'i başlat
echo "[STARTUP] Node.js sunucusu başlatılıyor..."
exec node server.js
