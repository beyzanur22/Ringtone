/* =========================================================================
   POPÜLER ALBÜMLER — ülke başına HAFTADA BİR çekilir, Redis'te saklanır.
   Kaynak: YouTube Music (ülke listesi → sanatçının en çok dinlenen albümü).
   Kullanıcı istekleri YouTube'a GİTMEZ; sadece kayıtlı listeyi okur.
   Şarkı çalma/indirme yine mevcut /stream ve /download/mp3 (videoId) yolundan.
========================================================================= */
const fs = require("fs");
const path = require("path");

const YTM_URL = "https://music.youtube.com/youtubei/v1/";
const YTM_CLIENT = { clientName: "WEB_REMIX", clientVersion: "1.20251020.01.00", hl: "en" };
const REFRESH_MS = 7 * 24 * 3600 * 1000;   // haftada bir
const CHECK_MS = 30 * 60 * 1000;           // 30 dk'da bir: eksik/süresi dolan liste var mı (yenileme yine haftada bir)
const REGION_LIMIT = 15;                    // en çok istek gelen ilk 15 ülke
const ARTIST_LIMIT = 40;                    // ülke listesindeki ilk 40 sanatçı
const MIN_ALBUMS = 5;                       // bundan azsa eski liste korunur
const GAP_MS = 400;                         // YouTube'a istekler arası bekleme
const K = { list: cc => `albums:list:${cc}`, item: id => `albums:item:${id}`, wanted: "albums:wanted", lock: cc => `albums:lock:${cc}` };
const GLOBAL = "GLOBAL";                    // ülke listesi yoksa / desteklenmiyorsa gösterilen dünya listesi
// YouTube Music'in ülke listesi tuttuğu 68 ülke. Diğerleri sessizce dünya listesini döndürüyor → onlara GLOBAL.
const SUPPORTED = new Set(("AR AU AT BE BO BR CA CL CO CR CZ DK DO EC EG SV EE FI FR DE GT HN HK HU IS IN ID IE IL IT JP KE " +
  "LU MY MX NL NZ NI NG NO PA PY PE PH PL PT RO RU SA RS SG ZA KR ES SE CH TW TZ TH TR UG UA AE GB US UY VN ZW").split(" "));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- JSON yardımcıları (YouTube Music cevabı derin iç içe) ----
function* walk(o, key) {
  if (Array.isArray(o)) { for (const v of o) yield* walk(v, key); }
  else if (o && typeof o === "object") {
    for (const k of Object.keys(o)) { if (k === key) yield o[k]; yield* walk(o[k], key); }
  }
}
const first = (o, key) => { for (const v of walk(o, key)) return v; return undefined; };
const txt = r => ((r && r.runs) || []).map(x => x.text || "").join("");
const colText = c => txt(((c || {}).musicResponsiveListItemFlexColumnRenderer || {}).text);
const bigCover = u => String(u || "").replace(/=w\d+-h\d+[^/]*$/, "=w544-h544-l90-rj");
function playsNum(s) {
  const m = /([\d.]+)\s*([KMB]?)/.exec(s || "");
  return m ? parseFloat(m[1]) * ({ "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2]]) : 0;
}

// ---- Ayrıştırıcılar (saf fonksiyon — test edilebilir) ----
function parseCharts(d) {
  const artists = [];
  for (const s of walk(d, "musicCarouselShelfRenderer")) {
    if (txt(first(s, "title")) !== "Top artists") continue;
    for (const it of s.contents || []) {
      const r = it.musicResponsiveListItemRenderer || it.musicTwoRowItemRenderer || {};
      const name = r.flexColumns ? colText(r.flexColumns[0]) : txt(r.title);
      const id = first(r, "browseId");
      if (name && id) artists.push({ name, id });
    }
  }
  return artists;
}
function parseArtist(d) {
  const top = [];
  const shelf = first(d, "musicShelfRenderer");          // "Top songs"
  for (const r of walk(shelf || {}, "musicResponsiveListItemRenderer")) {
    let album = null, plays = 0;
    for (const c of (r.flexColumns || []).slice(1)) {
      const t = ((c.musicResponsiveListItemFlexColumnRenderer || {}).text || {});
      for (const run of t.runs || []) {
        const b = ((run.navigationEndpoint || {}).browseEndpoint || {}).browseId || "";
        if (b.startsWith("MPRE")) album = b;
      }
      const s = txt(t);
      if (/plays|views/i.test(s)) plays = playsNum(s);
    }
    top.push({ album, plays });
  }
  const shelfAlbums = [];
  for (const s of walk(d, "musicCarouselShelfRenderer")) {
    if (txt(first(s, "title")) !== "Albums") continue;
    for (const it of s.contents || []) {
      const b = [...walk(it, "browseId")].find(x => String(x).startsWith("MPRE"));
      if (b) shelfAlbums.push(b);
    }
  }
  return { top, shelfAlbums };
}
function parseAlbum(d, id) {
  const head = first(d, "musicResponsiveHeaderRenderer") || first(d, "musicDetailHeaderRenderer") || {};
  const sub = txt(head.subtitle);                      // "Album • 2026" / "EP • 2025"
  const thumbs = first(head, "thumbnails") || [];
  const tracks = [];
  for (const r of walk(d, "musicResponsiveListItemRenderer")) {
    const videoId = ((r.playlistItemData || {}).videoId) || first(r, "videoId");
    const title = colText((r.flexColumns || [])[0]);
    if (videoId && title) tracks.push({ videoId, title });
  }
  const yearM = /(\d{4})/.exec(sub);
  return {
    id, title: txt(head.title), artist: txt(head.straplineTextOne),
    type: (sub.split("•")[0] || "").trim(), year: yearM ? yearM[1] : "",
    cover: bigCover((thumbs[thumbs.length - 1] || {}).url),
    playlistId: [...walk(d, "playlistId")].find(p => String(p).startsWith("OLAK")) || null,
    tracks,
  };
}

// ---- YouTube Music istekleri ----
// IPv4 zorunlu: sunucuda IPv6 rotası takılınca fetch 20 sn bekleyip düşüyordu.
const https = require("https");
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = https.request(url, {
      method: "POST", family: 4, timeout: timeoutMs,
      headers: { "Content-Type": "application/json", "Content-Length": data.length, "User-Agent": "Mozilla/5.0", Origin: "https://music.youtube.com" },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("zaman aşımı")));
    req.on("error", reject);
    req.end(data);
  });
}
async function ytm(endpoint, body, gl) {
  const payload = { context: { client: { ...YTM_CLIENT, gl } }, ...body };
  let last;
  for (let i = 0; i < 3; i++) {                       // 3 deneme: 30 sn zaman aşımı, arada 2 / 6 sn
    try {
      const d = await postJson(`${YTM_URL}${endpoint}?prettyPrint=false`, payload, 30000);
      await sleep(GAP_MS);
      return d;
    } catch (e) { last = e; await sleep(i ? 6000 : 2000); }
  }
  throw new Error(`YTM ${endpoint}: ${last && last.message}`);
}
const albumCache = new Map();
async function getAlbum(id, cc) {
  if (!albumCache.has(id)) albumCache.set(id, parseAlbum(await ytm("browse", { browseId: id }, cc), id));
  return albumCache.get(id);
}
// Sanatçının en çok dinlenen albümü: "Top songs" dinlenmeleri albüm başına toplanır, single atlanır
async function bestAlbum(artist, cc) {
  const { top, shelfAlbums } = parseArtist(await ytm("browse", { browseId: artist.id }, cc));
  const score = new Map();
  for (const t of top) if (t.album) score.set(t.album, (score.get(t.album) || 0) + t.plays);
  const byPlays = [...score.keys()].sort((a, b) => score.get(b) - score.get(a));
  for (const id of byPlays) {
    const a = await getAlbum(id, cc);
    if (/^(Album|EP)$/.test(a.type) && a.tracks.length >= 3) return a;
  }
  for (const id of shelfAlbums) {               // yedek: sanatçının albüm rafı
    const a = await getAlbum(id, cc);
    if (a.tracks.length >= 3) return a;
  }
  return null;
}
async function chartArtists(code) {
  const gl = code === "ZZ" ? "US" : code;      // "ZZ" = YouTube Music dünya listesi
  return parseCharts(await ytm("browse", { browseId: "FEmusic_charts", formData: { selectedValues: [code] } }, gl));
}
// Dünya listesi: hacme göre sıralanan "ZZ" Hint derlemeleriyle doluyor → dünyaca tanınan
// ABD + İngiltere listeleri sırayla karıştırılır; eksik kalırsa "ZZ" ile tamamlanır
async function globalArtists() {
  const out = [], seen = new Set();
  const add = a => { if (a && !seen.has(a.id) && out.length < ARTIST_LIMIT) { seen.add(a.id); out.push(a); } };
  const lists = [await chartArtists("US"), await chartArtists("GB")];
  for (let i = 0; out.length < ARTIST_LIMIT && lists.some(l => i < l.length); i++) lists.forEach(l => add(l[i]));
  if (out.length < ARTIST_LIMIT) (await chartArtists("ZZ")).forEach(add);
  return out;
}
async function buildCountry(cc) {
  albumCache.clear();
  const artists = cc === GLOBAL ? await globalArtists() : (await chartArtists(cc)).slice(0, ARTIST_LIMIT);
  const gl = cc === GLOBAL ? "US" : cc;
  console.log(`[ALBUMS] ${cc}: başladı (${artists.length} sanatçı)`);
  const out = [], seen = new Set();
  let fails = 0;
  for (const ar of artists) {
    try {
      const a = await bestAlbum(ar, gl);
      fails = 0;
      if (a && !seen.has(a.id)) { seen.add(a.id); out.push({ ...a, artist: a.artist || ar.name }); }
    } catch (e) {
      console.warn(`[ALBUMS] ${cc} ${ar.name}: ${e.message}`);
      if (++fails >= 5) throw new Error("art arda 5 sanatçı alınamadı — YouTube erişimi sorunlu");
    }
  }
  return out;
}

module.exports = function setupAlbums(app, { redis, isPrimaryWorker, regionsKey, dataDir }) {
  const fileDir = path.join(dataDir, "albums");
  try { fs.mkdirSync(fileDir, { recursive: true }); } catch (e) {}
  const countryOf = req => String(req.headers["cf-ipcountry"] || req.headers["x-country"] || "US").toUpperCase().slice(0, 2);
  const slim = a => ({ id: a.id, title: a.title, artist: a.artist, year: a.year, type: a.type, cover: a.cover, trackCount: a.tracks.length });

  async function readList(cc) {
    try { const v = await redis.get(K.list(cc)); if (v) return JSON.parse(v); } catch (e) {}
    try { return JSON.parse(fs.readFileSync(path.join(fileDir, `${cc}.json`), "utf-8")); } catch (e) { return null; }
  }

  async function refreshCountry(cc) {
    const got = await redis.set(K.lock(cc), String(process.pid), "PX", 3600 * 1000, "NX").catch(() => null);
    if (got !== "OK") return;
    const t0 = Date.now();
    try {
      const albums = await buildCountry(cc);
      if (albums.length < MIN_ALBUMS) { console.warn(`[ALBUMS] ${cc}: sadece ${albums.length} albüm — eski liste korunuyor`); return; }
      const list = { region: cc, updatedAt: Date.now(), albums: albums.map(slim) };
      const multi = redis.multi().set(K.list(cc), JSON.stringify(list));
      for (const a of albums) multi.set(K.item(a.id), JSON.stringify(a), "EX", 30 * 24 * 3600);
      await multi.exec();
      fs.writeFileSync(path.join(fileDir, `${cc}.json`), JSON.stringify(list));
      console.log(`[ALBUMS] ${cc}: ${albums.length} albüm (${Math.round((Date.now() - t0) / 1000)} sn)`);
    } catch (e) {
      console.warn(`[ALBUMS] ${cc} yenilenemedi, eski liste korunuyor: ${e.message}`);
    } finally {
      redis.srem(K.wanted, cc).catch(() => {});   // başarısızsa da düşer; ülke yeniden istenirse tekrar eklenir
      redis.del(K.lock(cc)).catch(() => {});
    }
  }

  // Yalnızca 1. worker: süresi dolan (7 gün) ya da hiç olmayan ülkeleri sırayla yenile
  async function checkAll() {
    let regions = [];
    try { regions = await redis.zrevrange(regionsKey, 0, REGION_LIMIT - 1); } catch (e) {}
    let wanted = [];
    try { wanted = await redis.smembers(K.wanted); } catch (e) {}
    // Önce dünya listesi (her ülkenin yedeği), sonra desteklenen ülkeler
    const all = [GLOBAL, ...[...new Set([...(regions || []), ...(wanted || [])])].filter(c => SUPPORTED.has(c)).slice(0, 25)];
    for (const cc of all) {
      const cur = await readList(cc);
      if (!cur || Date.now() - (cur.updatedAt || 0) > REFRESH_MS) await refreshCountry(cc);
    }
  }
  if (isPrimaryWorker) {
    // Yeniden başlatmada yarıda kalan çekimin kilidi kalmasın (yoksa o ülke 1 saat atlanırdı)
    redis.keys("albums:lock:*").then(k => k.length && redis.del(...k)).catch(() => {});
    setTimeout(() => checkAll().catch(e => console.warn(`[ALBUMS] kontrol hatası: ${e.message}`)), 60 * 1000);
    setInterval(() => checkAll().catch(e => console.warn(`[ALBUMS] kontrol hatası: ${e.message}`)), CHECK_MS);
  }

  // Uygulama: ülkenin popüler albümleri (kapaklı liste, parçasız)
  app.get("/albums", async (req, res) => {
    const cc = countryOf(req);
    let list = SUPPORTED.has(cc) ? await readList(cc) : null;
    if (!list) {
      if (SUPPORTED.has(cc)) redis.sadd(K.wanted, cc).catch(() => {});   // ülke listesi bir sonraki kontrolde çekilir
      list = await readList(GLOBAL);                                       // o zamana kadar / desteklenmiyorsa dünya listesi
      if (!list) return res.json({ region: GLOBAL, updatedAt: null, albums: [] });
    }
    // Ülkeye göre değişir: ortak önbelleğe (Cloudflare) girmesin, cihaz yarım saat tutsun
    res.set({ "Cache-Control": "private, max-age=1800", Vary: "CF-IPCountry, X-Country" });
    res.json(list);
  });

  // Uygulama: tek albüm (kapak + parça listesi; parçalar videoId ile mevcut çalma/indirme yolundan)
  app.get("/albums/:id", async (req, res) => {
    const id = String(req.params.id || "");
    if (!/^MPRE[\w-]{6,}$/.test(id)) return res.status(400).json({ error: "Geçersiz albüm" });
    try {
      const v = await redis.get(K.item(id));
      if (v) { res.set("Cache-Control", "public, max-age=3600"); return res.json(JSON.parse(v)); }
    } catch (e) {}
    res.status(404).json({ error: "Albüm bulunamadı" });
  });
};

module.exports._test = { parseCharts, parseArtist, parseAlbum, playsNum, bigCover };
