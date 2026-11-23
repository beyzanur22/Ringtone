/* =========================================================================
   AKTİF KULLANICI ZAMAN SERİSİ — panel grafikleri (Canlı / Zil Sesi / Genel Bakış)
   Dakikada bir (yalnız primary worker) son 5 dk aktif cihaz sayısı örneklenir:
   uygulama başına toplam, zil sesi, müzik ve ülke kırılımı.
     stats:m:<app>:<YYYYMMDDHHmm>  dakika  (3 saat)
     stats:h:<app>:<YYYYMMDDHH>    saat, UTC (35 gün)  — s|alan toplam, m|alan tepe, _n örnek
     stats:d:<app>:<YYYYMMDD>      gün, İstanbul (40 gün)
   <app>: "all" (tüm uygulamalar), "default" (Musica + kayıtsız paketler) veya app id.
========================================================================= */

const MIN_TTL = 3 * 3600;
const HOUR_TTL = 35 * 86400;
const DAY_TTL = 40 * 86400;
const TZ_MS = 3 * 3600 * 1000;   // İstanbul (yaz saati yok)
const ACTIVE_MS = 5 * 60 * 1000;

const minStr = (ms) => new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, "");
const hourStr = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");
const dayStr = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10).replace(/-/g, "");
const K = {
  m: (app, ms) => `stats:m:${app}:${minStr(ms)}`,
  h: (app, ms) => `stats:h:${app}:${hourStr(ms)}`,
  d: (app, ms) => `stats:d:${app}:${dayStr(ms)}`,
  lock: (ms) => `stats:lock:${minStr(ms)}`,
};

// Toplam + tepe birikimi (s|alan, m|alan, _n)
const AGG_LUA = `
redis.call('HINCRBY', KEYS[1], '_n', 1)
for i = 2, #ARGV, 2 do
  local f = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[1], 's|' .. f, v)
  local m = tonumber(redis.call('HGET', KEYS[1], 'm|' .. f) or '-1')
  if v > m then redis.call('HSET', KEYS[1], 'm|' .. f, v) end
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1`;

const RANGES = {
  live: { unit: "minute", n: 15 },
  "1h": { unit: "minute", n: 60 },
  "24h": { unit: "hour", n: 24 },
  "7d": { unit: "hour", n: 168 },
  "30d": { unit: "day", n: 30 },
};

module.exports = function (app, deps) {
  const { redis, isPrimaryWorker, basicAuth, getApps, isMasterRequest, resolveAppFromKey,
    PRESENCE_ZKEY, presenceZKeyApp, presenceModeZKey, presenceKey, presenceExtractorZKeyApp,
    visHourKey, visDayKey, visCcKey, visHourStr, visDayStr, VIS_OTHER } = deps;

  redis.defineCommand("statsAgg", { numberOfKeys: 1, lua: AGG_LUA });

  async function sample() {
    const nowMs = Date.now();
    const got = await redis.set(K.lock(nowMs), "1", "EX", 120, "NX");
    if (!got) return;
    const from = nowMs - ACTIVE_MS;
    const ids = Object.keys(getApps()).filter(id => id !== "default");

    // Toplam / zil sesi / müzik — panelin mevcut sayaçlarıyla aynı kümeler
    const p = redis.pipeline();
    for (const scope of [null, ...ids]) {
      p.zcount(presenceZKeyApp(scope), from, "+inf");
      p.zcount(presenceModeZKey("ringtone", scope), from, "+inf");
      p.zcount(presenceModeZKey("youtube", scope), from, "+inf");
      p.zcount(presenceExtractorZKeyApp("newpipe", scope), from, "+inf");
      p.zcount(presenceExtractorZKeyApp("backend", scope), from, "+inf");
    }
    const r = (await p.exec()).map(([e, v]) => (e ? 0 : Number(v) || 0));
    const rows = {};
    [null, ...ids].forEach((scope, i) => {
      const o = i * 5;
      // n: NewPipe (cihazda çözüm), b: Backend API
      rows[scope || "all"] = { t: r[o], r: r[o + 1], y: r[o + 2], n: r[o + 3], b: r[o + 4] };
    });
    const sum = (f) => ids.reduce((a, id) => a + rows[id][f], 0);
    rows.default = {};
    ["t", "r", "y", "n", "b"].forEach(f => { rows.default[f] = Math.max(0, rows.all[f] - sum(f)); });

    // Ülke kırılımı — cihaz kaydındaki ülke + uygulama
    const known = new Set(ids);
    const uids = await redis.zrangebyscore(PRESENCE_ZKEY, from, "+inf");
    for (let i = 0; i < uids.length; i += 1000) {
      const chunk = uids.slice(i, i + 1000);
      const hp = redis.pipeline();
      chunk.forEach(uid => hp.hmget(presenceKey(uid), "country", "appId"));
      const hr = await hp.exec();
      hr.forEach(([e, v]) => {
        if (e || !v) return;
        const cc = /^[A-Z]{2}$/.test(String(v[0] || "").toUpperCase()) ? String(v[0]).toUpperCase() : "XX";
        const a = known.has(v[1]) ? v[1] : "default";
        for (const key of ["all", a]) {
          const f = "c|" + cc;
          rows[key][f] = (rows[key][f] || 0) + 1;
        }
      });
    }

    const w = redis.pipeline();
    for (const [a, fields] of Object.entries(rows)) {
      const flat = Object.entries(fields).flat();
      w.hset(K.m(a, nowMs), fields);
      w.expire(K.m(a, nowMs), MIN_TTL);
      w.statsAgg(K.h(a, nowMs), HOUR_TTL, ...flat);
      w.statsAgg(K.d(a, nowMs), DAY_TTL, ...flat);
    }
    await w.exec();
  }

  if (isPrimaryWorker) {
    const run = () => sample().catch(e => console.error("[STATS] örnekleme hatası:", e.message));
    // Dakika başına hizala (+5 sn), sonra dakikada bir
    setTimeout(() => { run(); setInterval(run, 60 * 1000).unref(); }, 65 * 1000 - (Date.now() % 60000)).unref();
  }

  // Bir anahtar listesini noktalara çevirir. Dakika: ham değer; saat/gün: ortalama + tepe.
  async function readPoints(appKey, unit, slots) {
    const p = redis.pipeline();
    slots.forEach(ms => p.hgetall(K[unit === "minute" ? "m" : unit === "hour" ? "h" : "d"](appKey, ms)));
    const res = await p.exec();
    return res.map(([e, h], i) => {
      const ts = slots[i];
      if (e || !h || !Object.keys(h).length) return { ts, missing: true };
      const pt = { ts, c: {}, cMax: {} };
      if (unit === "minute") {
        for (const [f, v] of Object.entries(h)) {
          if (f.startsWith("c|")) pt.c[f.slice(2)] = Number(v) || 0;
          else pt[f] = Number(v) || 0;
        }
        pt.tMax = pt.t; pt.rMax = pt.r; pt.yMax = pt.y; pt.nMax = pt.n; pt.bMax = pt.b;
        pt.cMax = pt.c;
      } else {
        const n = Number(h._n) || 1;
        const avg = (v) => Math.round(((Number(v) || 0) / n) * 10) / 10;
        for (const [f, v] of Object.entries(h)) {
          const kind = f.slice(0, 2), name = f.slice(2);
          if (kind !== "s|" && kind !== "m|") continue;
          const isMax = kind === "m|";
          if (name.startsWith("c|")) (isMax ? pt.cMax : pt.c)[name.slice(2)] = isMax ? Number(v) || 0 : avg(v);
          else pt[isMax ? name + "Max" : name] = isMax ? Number(v) || 0 : avg(v);
        }
        pt.samples = n;
      }
      // n/b eski kayıtlarda yok → null (grafikte boşluk)
      ["t", "r", "y"].forEach(f => { if (pt[f] == null) pt[f] = 0; if (pt[f + "Max"] == null) pt[f + "Max"] = 0; });
      pt.u = Math.max(0, Math.round((pt.t - pt.r - pt.y) * 10) / 10);
      pt.xu = pt.n == null || pt.b == null ? null : Math.max(0, Math.round((pt.t - pt.n - pt.b) * 10) / 10);
      return pt;
    });
  }

  function buildSlots(range, nowMs) {
    const { unit, n } = RANGES[range];
    const slots = [];
    if (unit === "minute") {
      const cur = Math.floor(nowMs / 60000) * 60000;
      for (let i = n - 1; i >= 0; i--) slots.push(cur - i * 60000);
    } else if (unit === "hour") {
      const cur = Math.floor(nowMs / 3600000) * 3600000;
      for (let i = n - 1; i >= 0; i--) slots.push(cur - i * 3600000);
    } else {
      // İstanbul gece yarısı (UTC ms)
      const cur = Math.floor((nowMs + TZ_MS) / 86400000) * 86400000 - TZ_MS;
      for (let i = n - 1; i >= 0; i--) slots.push(cur - i * 86400000);
    }
    return { unit, slots };
  }

  /* GET /admin/stats-series?range=live|1h|24h|7d|30d&appId=all|default|<id>[&byApp=1]
     İzole panel (per-app key) yalnız kendi uygulamasını görür; byApp süper panele özel. */
  app.get("/admin/stats-series", basicAuth, async (req, res) => {
    try {
      const range = RANGES[req.query.range] ? req.query.range : "24h";
      const bound = resolveAppFromKey(req.headers["x-app-key"]);
      const master = !bound && isMasterRequest(req);
      if (!bound && !master) return res.status(403).json({ error: "yetkisiz" });
      const apps = getApps();
      let appKey = bound;
      if (!appKey) {
        const raw = String(req.query.appId || "all").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        appKey = raw === "all" || raw === "default" || apps[raw] ? raw : null;
        if (!appKey) return res.status(400).json({ error: "bilinmeyen uygulama" });
      }

      const nowMs = Date.now();
      const { unit, slots } = buildSlots(range, nowMs);
      let points = await readPoints(appKey, unit, slots);
      // Bu dakika henüz örneklenmediyse sondaki boş noktayı at
      if (unit === "minute" && points.length && points[points.length - 1].missing) points = points.slice(0, -1);

      // Ülke sıralaması: dakikada son nokta, uzun aralıkta dönem ortalaması
      const filled = points.filter(p => !p.missing);
      const cc = {};
      if (unit === "minute") {
        const last = filled[filled.length - 1];
        if (last) Object.assign(cc, last.c);
      } else if (filled.length) {
        filled.forEach(p => Object.entries(p.c).forEach(([k, v]) => { cc[k] = (cc[k] || 0) + v; }));
        Object.keys(cc).forEach(k => { cc[k] = Math.round((cc[k] / filled.length) * 10) / 10; });
      }
      const countries = Object.entries(cc).map(([country, value]) => ({ country, value }))
        .filter(c => c.value > 0).sort((a, b) => b.value - a.value);

      // Uygulama kırılımı (süper panel): her uygulamanın toplam/zil sesi/müzik serisi
      let byApp = null;
      if (master && req.query.byApp === "1") {
        const keys = ["default", ...Object.keys(apps).filter(id => id !== "default")];
        const all = await Promise.all(keys.map(k => readPoints(k, unit, slots.slice(0, points.length))));
        byApp = keys.map((id, i) => ({
          id,
          name: id === "default" ? ((apps.default && apps.default.name) || "Musica") + " + kayıtsız" : ((apps[id] && apps[id].name) || id),
          brand: (apps[id] && apps[id].brandPrimary) || null,
          series: all[i].map(p => (p.missing ? null : { t: p.t, r: p.r, y: p.y, tMax: p.tMax, rMax: p.rMax, yMax: p.yMax })),
        }));
      }

      res.json({
        app: appKey, range, unit,
        points: points.map(p => (p.missing ? { ts: p.ts, missing: true } : p)),
        countries,
        byApp,
        updatedAt: new Date(nowMs).toISOString(),
      });
    } catch (e) {
      console.error("[STATS] seri hatası:", e.message);
      res.status(500).json({ error: "Seri hatası: " + e.message });
    }
  });

  /* GET /admin/visitor-series?range=24h|7d|30d&appId=all|default|<id>
     Kaç farklı kişi girdi: saat (24h) ya da gün (7d/30d, UTC) başına, ülke kırılımlı.
     Kaynak: ziyaretçi HLL'leri (vis:h / vis:d). Toplamlar tekilleştirilmiş (PFCOUNT birleşimi). */
  const visCache = new Map();
  // Anlık: son 1 dk'da görülen cihazlar, ülke kırılımlı (uygulama 15 sn'de bir yoklar)
  async function liveCountries(scope) {
    const nowMs = Date.now();
    const zkey = scope === "all" ? PRESENCE_ZKEY : presenceZKeyApp(scope);
    const uids = await redis.zrevrangebyscore(zkey, "+inf", nowMs - 60000);
    const byCc = {};
    if (uids.length) {
      const p = redis.pipeline();
      uids.forEach(u => p.hget(presenceKey(u), "country"));
      (await p.exec()).forEach(([e, v]) => {
        const cc = !e && /^[A-Z]{2}$/.test(String(v || "").toUpperCase()) ? String(v).toUpperCase() : "XX";
        byCc[cc] = (byCc[cc] || 0) + 1;
      });
    }
    const countries = Object.entries(byCc).map(([country, value]) => ({ country, value })).sort((a, b) => b.value - a.value);
    return { app: scope, range: "live", unit: "now", points: [], countries, total: uids.length, updatedAt: new Date(nowMs).toISOString() };
  }
  app.get("/admin/visitor-series", basicAuth, async (req, res) => {
    try {
      const range = ["live", "24h", "7d", "30d"].includes(req.query.range) ? req.query.range : "24h";
      const bound = resolveAppFromKey(req.headers["x-app-key"]);
      const master = !bound && isMasterRequest(req);
      if (!bound && !master) return res.status(403).json({ error: "yetkisiz" });
      const all = getApps();
      let scope = bound;
      if (!scope) {
        const raw = String(req.query.appId || "all").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        scope = raw === "all" || raw === "default" || all[raw] ? raw : null;
        if (!scope) return res.status(400).json({ error: "bilinmeyen uygulama" });
      }
      const appIds = scope === "all" ? [...Object.keys(all), VIS_OTHER] : [scope];
      if (range === "live") return res.json(await liveCountries(scope));
      const ck = scope + "|" + range;
      const hit = visCache.get(ck);
      if (hit && Date.now() - hit.at < 60000) return res.json(hit.data);

      const nowMs = Date.now();
      const unit = range === "24h" ? "hour" : "day";
      const n = range === "24h" ? 24 : range === "7d" ? 7 : 30;
      const buckets = [];
      for (let i = n - 1; i >= 0; i--) {
        const ms = unit === "hour" ? nowMs - i * 3600000 : nowMs - i * 86400000;
        const id = unit === "hour" ? visHourStr(ms) : visDayStr(ms);
        const ts = unit === "hour"
          ? Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10))
          : Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8));
        buckets.push({ id, ts, day: unit === "hour" ? id.slice(0, 8) : id });
      }
      const keyOf = (a, b, cc) => (unit === "hour" ? visHourKey(a, b.id, cc) : visDayKey(a, b.id, cc));

      // Aralıkta görülen ülkeler
      const days = [...new Set(buckets.map(b => b.day))];
      const cp = redis.pipeline();
      appIds.forEach(a => days.forEach(d => cp.smembers(visCcKey(a, d))));
      const ccs = [...new Set((await cp.exec()).flatMap(([e, v]) => (e || !v ? [] : v)))];

      const p = redis.pipeline();
      buckets.forEach(b => p.pfcount(...appIds.map(a => keyOf(a, b))));
      buckets.forEach(b => ccs.forEach(cc => p.pfcount(...appIds.map(a => keyOf(a, b, cc)))));
      ccs.forEach(cc => p.pfcount(...buckets.flatMap(b => appIds.map(a => keyOf(a, b, cc)))));
      p.pfcount(...buckets.flatMap(b => appIds.map(a => keyOf(a, b))));
      const r = (await p.exec()).map(([e, v]) => (e ? 0 : Number(v) || 0));
      let i = 0;
      const points = buckets.map(b => ({ ts: b.ts, total: r[i++], c: {} }));
      points.forEach(pt => ccs.forEach(cc => { const v = r[i++]; if (v) pt.c[cc] = v; }));
      const countries = ccs.map(cc => ({ country: cc, value: r[i++] })).filter(c => c.value > 0).sort((a, b) => b.value - a.value);
      const total = r[i++];
      const data = { app: scope, range, unit, tz: "UTC", points, countries, total, updatedAt: new Date(nowMs).toISOString() };
      visCache.set(ck, { at: Date.now(), data });
      if (visCache.size > 200) visCache.clear();
      res.json(data);
    } catch (e) {
      console.error("[STATS] ziyaretçi serisi hatası:", e.message);
      res.status(500).json({ error: "Ziyaretçi serisi hatası: " + e.message });
    }
  });
};
