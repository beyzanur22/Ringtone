#!/bin/bash
# ============================================================
# RingtoneMaster HTTPS Kurulumu — Nginx + Let's Encrypt
# Bu script'i sunucuda root olarak çalıştır:
#   chmod +x nginx-ssl-setup.sh && ./nginx-ssl-setup.sh
# ============================================================

set -e

DOMAIN="173.212.249.105"
BACKEND_PORT=5000

echo "=== 1/4: Nginx kurulumu ==="
apt update && apt install -y nginx

echo "=== 2/4: Nginx config ==="
cat > /etc/nginx/sites-available/ringtone-backend << 'NGINX_CONF'
# HTTP → HTTPS yönlendirme (IP ile SSL: self-signed kullanılacak)
server {
    listen 80;
    server_name 173.212.249.105;

    # Geçiş süresinde HTTP'yi de aç (eski APK'lar için)
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Streaming için büyük buffer ve uzun timeout
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 100M;
    }
}

# HTTPS (self-signed — IP ile domain yoksa bu gerekir)
server {
    listen 443 ssl;
    server_name 173.212.249.105;

    ssl_certificate /etc/ssl/certs/ringtone-selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/ringtone-selfsigned.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Streaming için büyük buffer ve uzun timeout
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 100M;
    }
}
NGINX_CONF

echo "=== 3/4: Self-signed SSL sertifikası ==="
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/ssl/private/ringtone-selfsigned.key \
    -out /etc/ssl/certs/ringtone-selfsigned.crt \
    -subj "/C=TR/ST=Istanbul/L=Istanbul/O=RingtoneMaster/CN=173.212.249.105"

echo "=== 4/4: Nginx aktifleştir ==="
ln -sf /etc/nginx/sites-available/ringtone-backend /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx

echo ""
echo "=============================================="
echo " HTTPS kurulumu tamamlandı!"
echo " HTTP:  http://173.212.249.105 (çalışır)"
echo " HTTPS: https://173.212.249.105 (self-signed)"
echo "=============================================="
echo ""
echo "NOT: Eğer bir domain alırsan (örn: api.ringtonemaster.com),"
echo "Let's Encrypt ile ücretsiz gerçek SSL alabilirsin:"
echo "  apt install certbot python3-certbot-nginx"
echo "  certbot --nginx -d api.ringtonemaster.com"
echo ""
echo "Android'de self-signed kullanmak için DownloaderImpl'de"
echo "ve MusicService'de trust-all-certs eklemen gerekiyor."
echo "VEYA daha iyi: domain al + Let's Encrypt kullan."
