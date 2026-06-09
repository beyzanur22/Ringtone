#!/bin/bash
# ═══════════════════════════════════════════════════
# MELODIA Admin Panel — Otomatik Deploy Script
# Sunucuda çalışır: git pull → npm build → kopyala
#
# Kullanım: bash deploy-admin.sh
# Webhook tarafından otomatik tetiklenir
# ═══════════════════════════════════════════════════

set -e

ADMIN_REPO_DIR="/opt/admin-frontend"
ADMIN_BUILD_DIR="/opt/app/admin_panel"
REPO_URL="${ADMIN_REPO_URL:-}"  # GitHub repo URL'si (env'den gelir)

echo "═══════════════════════════════════════════════"
echo "🎨 Admin Panel Deploy Başlıyor..."
echo "═══════════════════════════════════════════════"

# 1) Repo yoksa klonla, varsa pull yap
if [ ! -d "$ADMIN_REPO_DIR/.git" ]; then
    if [ -z "$REPO_URL" ]; then
        echo "❌ ADMIN_REPO_URL tanımlanmamış ve repo henüz klonlanmamış!"
        echo "   Kullanım: ADMIN_REPO_URL=https://github.com/user/repo.git bash deploy-admin.sh"
        exit 1
    fi
    echo "📥 Repo klonlanıyor: $REPO_URL"
    git clone "$REPO_URL" "$ADMIN_REPO_DIR"
else
    echo "📥 Git pull yapılıyor..."
    cd "$ADMIN_REPO_DIR"
    git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || echo "⚠️  Pull başarısız, mevcut ile devam ediliyor"
fi

cd "$ADMIN_REPO_DIR"

# 2) Dependencies yükle
echo "📦 npm install..."
npm install --production=false 2>&1 | tail -5

# 3) Build al
echo "🔨 npm run build..."
npm run build 2>&1 | tail -10

# 4) Build dosyalarını kopyala
if [ -d "$ADMIN_REPO_DIR/build" ]; then
    echo "📂 Build dosyaları kopyalanıyor → $ADMIN_BUILD_DIR"
    mkdir -p "$ADMIN_BUILD_DIR"
    rm -rf "$ADMIN_BUILD_DIR"/*
    cp -r "$ADMIN_REPO_DIR/build/"* "$ADMIN_BUILD_DIR/"
    echo "✅ Admin Panel deploy tamamlandı!"
    echo "   $(ls -la $ADMIN_BUILD_DIR | wc -l) dosya kopyalandı"
else
    echo "❌ Build klasörü bulunamadı!"
    exit 1
fi

echo "═══════════════════════════════════════════════"
echo "🎉 Deploy tamamlandı — /admin/panel güncel!"
echo "═══════════════════════════════════════════════"
