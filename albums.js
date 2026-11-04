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
const LIST_V = 2;                           // 2: parça süreleri eklendi → eski listeler bir kez yenilenir
// YouTube Music'in ülke listesi tuttuğu 68 ülke. Diğerleri sessizce dünya listesini döndürüyor → onlara GLOBAL.
const SUPPORTED = new Set(("AR AU AT BE BO BR CA CL CO CR CZ DK DO EC EG SV EE FI FR DE GT HN HK HU IS IN ID IE IL IT JP KE " +
  "LU MY MX NL NZ NI NG NO PA PY PE PH PL PT RO RU SA RS SG ZA KR ES SE CH TW TZ TH TR UG UA AE GB US UY VN ZW").split(" "));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Olay günlüğü: konsol + Redis (son 100 kayıt) — admin paneli tüm worker'lardan aynı listeyi görür
let logRedis = null;
function ev(cc, msg, level = "info") {
  (level === "warn" || level === "error" ? console.warn : console.log)(`[ALBUMS] ${cc}: ${msg}`);
  if (!logRedis) return;
  logRedis.multi().lpush("albums:log", JSON.stringify({ t: Date.now(), cc, msg, level })).ltrim("albums:log", 0, 99).exec().catch(() => {});
}

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
// "3:45" / "1:02:10" → saniye
const durSec = s => String(s || "").split(":").reduce((a, p) => (/^\d+$/.test(p) ? a * 60 + +p : NaN), 0) || 0;
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
    const dur = txt((((r.fixedColumns || [])[0] || {}).musicResponsiveListItemFixedColumnRenderer || {}).text);
    if (videoId && title) tracks.push({ videoId, title, duration: durSec(dur) });
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
  ev(cc, `başladı (${artists.length} sanatçı)`);
  const out = [], seen = new Set();
  let fails = 0;
  for (const ar of artists) {
    try {
      const a = await bestAlbum(ar, gl);
      fails = 0;
      if (a && !seen.has(a.id)) { seen.add(a.id); out.push({ ...a, artist: a.artist || ar.name }); }
    } catch (e) {
      ev(cc, `${ar.name}: ${e.message}`, "warn");
      if (++fails >= 5) throw new Error("art arda 5 sanatçı alınamadı — YouTube erişimi sorunlu");
    }
  }
  return out;
}

module.exports = function setupAlbums(app, { redis, isPrimaryWorker, regionsKey, dataDir, basicAuth, isMaster }) {
  logRedis = redis;
  const fileDir = path.join(dataDir, "albums");
  const itemDir = path.join(fileDir, "items");   // Redis boşalırsa albüm detayı buradan
  try { fs.mkdirSync(itemDir, { recursive: true }); } catch (e) {}
  // Önce uygulamanın bulduğu ülke (SIM → şebeke → IP), yoksa Cloudflare'in IP ülkesi
  const cc2 = v => { const s = String(v || "").trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : ""; };
  const countryOf = req => cc2(req.headers["x-country"]) || cc2(req.headers["cf-ipcountry"]) || "US";
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
      if (albums.length < MIN_ALBUMS) { ev(cc, `sadece ${albums.length} albüm — eski liste korunuyor`, "error"); return; }
      const list = { v: LIST_V, region: cc, updatedAt: Date.now(), albums: albums.map(slim) };
      const multi = redis.multi().set(K.list(cc), JSON.stringify(list));
      for (const a of albums) multi.set(K.item(a.id), JSON.stringify(a), "EX", 30 * 24 * 3600);
      await multi.exec();
      fs.writeFileSync(path.join(fileDir, `${cc}.json`), JSON.stringify(list));
      for (const a of albums) {
        try { fs.writeFileSync(path.join(itemDir, `${a.id}.json`), JSON.stringify(a)); } catch (e) {}
      }
      ev(cc, `${albums.length} albüm hazır (${Math.round((Date.now() - t0) / 1000)} sn)`, "ok");
    } catch (e) {
      ev(cc, `yenilenemedi, eski liste korunuyor: ${e.message}`, "error");
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
      if (!cur || cur.v !== LIST_V || Date.now() - (cur.updatedAt || 0) > REFRESH_MS) await refreshCountry(cc);
    }
  }
  if (isPrimaryWorker) {
    // Yeniden başlatmada yarıda kalan çekimin kilidi kalmasın (yoksa o ülke 1 saat atlanırdı)
    redis.keys("albums:lock:*").then(k => k.length && redis.del(...k)).catch(() => {});
    setTimeout(() => checkAll().catch(e => ev("KONTROL", e.message, "error")), 60 * 1000);
    setInterval(() => checkAll().catch(e => ev("KONTROL", e.message, "error")), CHECK_MS);
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
    try {
      const a = JSON.parse(fs.readFileSync(path.join(itemDir, `${id}.json`), "utf-8"));
      redis.set(K.item(id), JSON.stringify(a), "EX", 30 * 24 * 3600).catch(() => {});
      res.set("Cache-Control", "public, max-age=3600");
      return res.json(a);
    } catch (e) {}
    res.status(404).json({ error: "Albüm bulunamadı" });
  });

  // ---- ADMIN: albüm durumu (panel › İzleme › Albümler) ----
  app.get("/admin/albums/status", basicAuth, async (req, res) => {
    try {
      const now = Date.now();
      const top = await redis.zrevrange(regionsKey, 0, 39, "WITHSCORES").catch(() => []);
      const reqs = new Map();
      for (let i = 0; i < top.length; i += 2) reqs.set(top[i], Number(top[i + 1]) || 0);
      const topOrder = [...reqs.keys()];
      const wanted = await redis.smembers(K.wanted).catch(() => []);
      const listKeys = await redis.keys("albums:list:*").catch(() => []);
      const locks = new Set(await redis.keys("albums:lock:*").catch(() => []));
      let files = [];
      try { files = fs.readdirSync(fileDir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)); } catch (e) {}
      // checkAll'un takip ettiği ülkeler (aynı kural)
      const tracked = new Set([GLOBAL, ...[...new Set([...topOrder.slice(0, REGION_LIMIT), ...wanted])].filter(c => SUPPORTED.has(c)).slice(0, 25)]);
      const ccs = new Set([...tracked, ...listKeys.map(k => k.split(":")[2]), ...files]);

      const rows = [];
      for (const cc of ccs) {
        let list = null, inRedis = false, inFile = false;
        try { const v = await redis.get(K.list(cc)); if (v) { list = JSON.parse(v); inRedis = true; } } catch (e) {}
        try { const f = JSON.parse(fs.readFileSync(path.join(fileDir, `${cc}.json`), "utf-8")); inFile = true; if (!list) list = f; } catch (e) {}
        const albums = (list && list.albums) || [];
        let cachedItems = 0, itemFiles = 0;
        if (albums.length) {
          const vals = await redis.mget(...albums.map(a => K.item(a.id))).catch(() => []);
          cachedItems = vals.filter(Boolean).length;
          itemFiles = albums.filter(a => fs.existsSync(path.join(itemDir, `${a.id}.json`))).length;
        }
        const supported = cc === GLOBAL || SUPPORTED.has(cc);
        const age = list && list.updatedAt ? now - list.updatedAt : null;
        let status = "ok";
        if (locks.has(K.lock(cc))) status = "fetching";
        else if (!supported) status = "unsupported";
        else if (!list) status = "missing";
        else if (list.v !== LIST_V) status = "old_version";
        else if (age > REFRESH_MS) status = "stale";
        else if (!inRedis) status = "file_only";
        rows.push({
          cc, status, supported, tracked: tracked.has(cc), wanted: wanted.includes(cc), requests: reqs.get(cc) || 0,
          inRedis, inFile, albumCount: albums.length, cachedItems, itemFiles,
          updatedAt: (list && list.updatedAt) || null, v: (list && list.v) || 1,
          sample: albums.slice(0, 3).map(a => `${a.artist} — ${a.title}`),
        });
      }
      rows.sort((a, b) => (b.cc === GLOBAL) - (a.cc === GLOBAL) || b.requests - a.requests || a.cc.localeCompare(b.cc));
      const unsupportedTop = topOrder.filter(c => !SUPPORTED.has(c)).slice(0, 20).map(cc => ({ cc, requests: reqs.get(cc) }));
      const log = (await redis.lrange("albums:log", 0, 59).catch(() => []))
        .map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      res.json({ now, refreshMs: REFRESH_MS, checkMs: CHECK_MS, listVersion: LIST_V, rows, unsupportedTop, log,
        canRefresh: !!(isMaster && isMaster(req)) });
    } catch (e) {
      res.status(422).json({ error: e.message });
    }
  });

  // ADMIN: bir ülkeden istek gelse ne döner (yan etkisiz /albums)
  app.get("/admin/albums/test", basicAuth, async (req, res) => {
    const cc = cc2(req.query.cc) || "US";
    let list = SUPPORTED.has(cc) ? await readList(cc) : null;
    const fallback = !list;
    if (!list) list = await readList(GLOBAL);
    res.json({ cc, supported: SUPPORTED.has(cc), served: (list && list.region) || null, fallback,
      albumCount: ((list && list.albums) || []).length, updatedAt: (list && list.updatedAt) || null,
      albums: ((list && list.albums) || []).slice(0, 12) });
  });

  // ADMIN: ülke listesini şimdi yenile (yalnız süper admin; arka planda çalışır)
  app.post("/admin/albums/refresh", basicAuth, async (req, res) => {
    if (!isMaster || !isMaster(req)) return res.status(403).json({ error: "Sadece süper admin" });
    const cc = String(req.query.cc || "").toUpperCase();
    if (cc !== GLOBAL && !SUPPORTED.has(cc)) return res.status(422).json({ error: "Bu ülke için YouTube Music listesi yok" });
    if (await redis.exists(K.lock(cc)).catch(() => 0)) return res.json({ ok: true, already: true });
    ev(cc, "panelden elle yenileme başlatıldı");
    refreshCountry(cc).catch(() => {});
    res.json({ ok: true });
  });
};

module.exports._test = { parseCharts, parseArtist, parseAlbum, playsNum, bigCover, durSec };
