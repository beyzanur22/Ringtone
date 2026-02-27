require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG_FILE = "config.json";
const DATA_FILE = "blockedChannels.json";


//  Rate Limit: 1 IP adresi 1 dakika içinde en fazla 120 istek yapabilir.
// Bu limit backend'i spam ve aşırı yükten korur.
const rateLimit = require("express-rate-limit")

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120
})) 


// SEARCH ÖZEL RATE LIMIT
// 1 IP → 1 dakikada max 40 arama
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  message: {
    error: "Too many search requests. Please wait 1 minute."
  },
  handler: (req, res) => {
    console.log(" SEARCH RATE LIMIT:", req.ip)
    res.status(429).json({
      error: "Too many search requests. Try again in 1 minute."
    })
  }
}); 


// APP AUTH MIDDLEWARE
const APP_SECRET = process.env.APP_SECRET;

if (!APP_SECRET) {
  console.error(" APP_SECRET bulunamadı!");
  process.exit(1);
}

app.use((req, res, next) => {

  const clientKey = req.headers["x-app-key"];

  if (!clientKey || clientKey !== APP_SECRET) {
    console.log(" Unauthorized access attempt:", req.ip);
    return res.status(403).json({
      error: "Forbidden"
    });
  }

  next();
});


/* =========================
   CONFIG DOSYASI OLUŞTUR
========================= */

if (!fs.existsSync(CONFIG_FILE)) {
 const defaultConfig = {
  global: {
    enabled: true,
    mode: "youtube"
  },
  countries: {}
};
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
}


   //BLOCKED DOSYASI OLUŞTUR

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}

  // CONFIG GET
app.get("/config", (req, res) => {
  const data = fs.readFileSync(CONFIG_FILE);
  res.json(JSON.parse(data));
});


   //CONFIG UPDATE
app.post("/config", (req, res) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2));
  res.json({ message: "Config updated successfully" });
});


  // BLOCKED CHANNELS
app.get("/blocked-channels", (req, res) => {
  const data = fs.readFileSync(DATA_FILE);
  res.json(JSON.parse(data));
});

app.post("/blocked-channels", (req, res) => {
  const { channelName } = req.body;
  if (!channelName) {
    return res.status(400).json({ error: "Channel name required" });
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE));

  if (!data.includes(channelName)) {
    data.push(channelName);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  res.json({ message: "Channel blocked" });
});

app.delete("/blocked-channels/:name", (req, res) => {
  const name = req.params.name;
  let data = JSON.parse(fs.readFileSync(DATA_FILE));
  data = data.filter(ch => ch !== name);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ message: "Channel unblocked" });
});

//==================================

const axios = require("axios")

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

if (!YOUTUBE_API_KEY) {
  console.error(" YOUTUBE_API_KEY bulunamadı!");
  process.exit(1);
}


// CACHE TANIMI
let top50Cache = null
let top50CacheTime = 0

const CACHE_DURATION = 60 * 60 * 1000 // 1 saat


// TOP 50 ENDPOINT
app.get("/top50", async (req, res) => {
  try {

    const now = Date.now()

    //  CACHE KONTROLÜ
    if (top50Cache && (now - top50CacheTime < CACHE_DURATION)) {
      console.log("Top50 CACHE'den geldi")

      return res.json({
        source: "cache",
        data: top50Cache
      })
    }

    console.log("Top50 YouTube API'den çekiliyor...")

    const response = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "snippet,contentDetails,statistics",
          chart: "mostPopular",
          regionCode: "US",
          maxResults: 50,
          videoCategoryId: 10, // Music
          key: YOUTUBE_API_KEY
        }
      }
    )

    //  CACHE GÜNCELLE
    top50Cache = response.data.items
    top50CacheTime = now

    res.json({
      source: "youtube",
      data: top50Cache
    })

  } catch (error) {
    console.error("YouTube API error:", error.message)

    res.status(500).json({
      source: "error",
      error: "YouTube API error"
    })
  }
})


// SEARCH CACHE

let searchCache = {}
const SEARCH_CACHE_DURATION = 60 * 60 * 1000 // 1 saat 
app.get("/search", searchLimiter, async (req, res) => {

  console.log("SEARCH ENDPOINT TETİKLENDİ:", req.query.q);

  try {

    const query = req.query.q?.toLowerCase().trim()

    if (!query) {
      return res.status(400).json({ error: "Query required" })
    }

    if (query.length > 100) {
      return res.status(400).json({ error: "Query too long" })
    }

    const pageToken = req.query.pageToken || ""

    const cacheKey = query + "_" + pageToken
    const now = Date.now()

    // CACHE VAR MI?
    if (
      searchCache[cacheKey] &&
      (now - searchCache[cacheKey].time < SEARCH_CACHE_DURATION)
    ) {
      console.log("🔵 SEARCH CACHE'den geldi →", query)

      return res.json({
        source: "cache",
        nextPageToken: searchCache[cacheKey].data.nextPageToken,
        data: searchCache[cacheKey].data.data
      })
    }

    // YOUTUBE'A GİT
    console.log("🔴 SEARCH YouTube API'den çekiliyor →", query)

    const response = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          q: query,
          type: "video",
          maxResults: 20,
          pageToken: pageToken,
          key: YOUTUBE_API_KEY
        }
      }
    )
    const result = {
      nextPageToken: response.data.nextPageToken,
      data: response.data.items
    }

    // CACHE'E YAZ
    searchCache[cacheKey] = {
      data: result,
      time: now
    }

    res.json({
      source: "youtube",
      nextPageToken: result.nextPageToken,
      data: result.data
    })

  } catch (error) {
    console.error("SEARCH ERROR:", error.message)
    res.status(500).json({ error: "Search failed" })
  }
})
// =======================
// AUTO CACHE CLEANER
// =======================

setInterval(() => {
  console.log(" 1 saatlik periyodik cache temizliği yapıldı");

  searchCache = {};
  top50Cache = null;
  top50CacheTime = 0;

}, 60 * 60 * 1000); // 1 saat

// =======================
// SERVER START 
// =======================

app.listen(5000, "0.0.0.0", () => {
  console.log("Admin backend running on http://0.0.0.0:5000");

});

