#!/usr/bin/env bash
# Çok uygulamalı izolasyon regresyon testi.
# Kullanım:  BASE=http://localhost:PORT ./test-multi-app.sh
#            (veya BASE=https://music.cevapla.tv)
# Not: config yazma testleri X-App-Key ile admin erişimi kullanır.
set -u
BASE="${BASE:-http://localhost:3000}"
KEY="RINGTONE_MASTER_V2_SECRET_2026"
pass=0; fail=0
ok(){ echo "  ✅ $1"; pass=$((pass+1)); }
no(){ echo "  ❌ $1"; fail=$((fail+1)); }

echo "== BASE=$BASE =="

echo "[1] Kök config.json bozulmadan okunuyor mu (musica / default)"
D=$(curl -s "$BASE/config")
echo "$D" | grep -q '"global"' && ok "default /config global içeriyor" || no "default /config bozuk"

echo "[2] Bilinmeyen appId -> default'a düşüyor mu (fail-open)"
U=$(curl -s "$BASE/config" -H "X-App-Id: bilinmeyen_xyz")
[ "$U" = "$D" ] && ok "bilinmeyen appId = default" || no "bilinmeyen appId default'a düşmedi"

echo "[3] Path traversal engelli mi"
T=$(curl -s "$BASE/config" -H "X-App-Id: ../../etc")
[ "$T" = "$D" ] && ok "traversal sanitize edildi = default" || no "traversal default'a düşmedi (RİSK)"

echo "[4] memomusic kendi config'ini alıyor mu"
M=$(curl -s "$BASE/config" -H "X-App-Id: memomusic")
echo "$M" | grep -q '"global"' && ok "memomusic /config döndü" || no "memomusic /config boş"

echo "[5] memomusic'e config yazınca kök config.json DEĞİŞMEMELİ"
BEFORE=$(curl -s "$BASE/config")
curl -s -X POST "$BASE/config?appId=memomusic" -H "X-App-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"global":{"enabled":true,"mode":"ringtone"},"countries":{"TR":"ringtone"},"_test":true}' >/dev/null
AFTER=$(curl -s "$BASE/config")
[ "$BEFORE" = "$AFTER" ] && ok "kök config.json değişmedi" || no "KÖK CONFIG DEĞİŞTİ — İZOLASYON KIRIK!"

echo "[6] memomusic yazdığı modu geri okuyor mu (ringtone)"
RB=$(curl -s "$BASE/config" -H "X-App-Id: memomusic")
echo "$RB" | grep -q '"mode":"ringtone"' && ok "memomusic mode=ringtone kaydedildi" || no "memomusic modu okunamadı"

echo "[7] default hâlâ kendi modunda (memomusic'ten etkilenmedi)"
echo "$AFTER" | grep -q '"_test":true' && no "default'a memomusic verisi sızdı!" || ok "default izole kaldı"

echo "[8] Uygulama listesi (panel dropdown)"
A=$(curl -s "$BASE/admin/apps" -H "X-App-Key: $KEY")
echo "$A" | grep -q '"memomusic"' && ok "/admin/apps memomusic listeliyor" || no "/admin/apps memomusic yok"

echo
echo "== SONUÇ: $pass geçti, $fail kaldı =="
[ "$fail" -eq 0 ] && echo "TÜM TESTLER GEÇTİ ✅" || echo "BAŞARISIZ TEST VAR — deploy etme ❌"
