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
    echo "📥 Git fetch + origin'e hizalanıyor..."
    cd "$ADMIN_REPO_DIR"
    # ÖNEMLİ: Eskiden pull başarısız olsa bile build devam ediyordu → sunucudaki
    # bayat kodla build alınıp "yeni hash" üretiliyor, ama içerik eskiydi (multi-app
    # düzeltmesi canlıya hiç çıkmadı). Artık senkron olamazsak DURUYORUZ.
    BRANCH="$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')"
    BRANCH="${BRANCH:-main}"
    git fetch origin "$BRANCH" || { echo "❌ git fetch başarısız — deploy durduruldu (eski kodla build alınmayacak)"; exit 1; }
    # Sunucuda elle yapılmış değişiklikler origin'i gölgelemesin
    git reset --hard "origin/$BRANCH" || { echo "❌ origin/$BRANCH'e hizalanamadı — deploy durduruldu"; exit 1; }
    echo "   HEAD: $(git log --oneline -1)"
fi

cd "$ADMIN_REPO_DIR"

# 2) Dependencies yükle
echo "📦 npm install..."
npm install --production=false 2>&1 | tail -5

# 3) Build al
echo "🔨 npm run build..."
npm run build 2>&1 | tail -10

# 3.5) DOĞRULAMA — build gerçekten çok-uygulamalı kodu içeriyor mu?
# window.__APP_KEY__ okunmuyorsa panel master anahtarla çalışıyor demektir →
# tüm istekler "default"a düşer, izole panel (ogzmusic/memomusic) çalışmaz.
if ! grep -rq "__APP_KEY__" "$ADMIN_REPO_DIR/build/static/js/" 2>/dev/null; then
    echo "❌ Build doğrulaması BAŞARISIZ: __APP_KEY__ bulunamadı!"
    echo "   Bu build izole panelleri bozar (her istek 'default'a gider)."
    echo "   Mevcut panel korunuyor, deploy iptal edildi."
    exit 1
fi
echo "✅ Build doğrulandı (çok-uygulamalı kod mevcut)"

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
