#!/bin/bash

# Disk Alanı Temizliği (KRİTİK: Railway ephemeral disk dolabiliyor)
echo "[STARTUP] Disk alanı temizleniyor..."
rm -rf /app/cache/*
mkdir -p /app/cache

# JS çözücüleri önceden indir
echo "[STARTUP] yt-dlp JS çözücüler güncelleniyor..."
yt-dlp --remote-components ejs:github --version || true

# Node.js'i başlat
echo "[STARTUP] Node.js sunucusu başlatılıyor..."
exec node server.js
