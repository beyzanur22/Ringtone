require("dotenv").config();

const axios = require("axios");
const http = require("http");
const https = require("https");

const axiosClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

const express = require("express");
const ytdlp = require("yt-dlp-exec");
const cors = require("cors");
const fs = require("fs");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   RATE LIMIT
========================= */

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 500
}));

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40
});

/* =========================
   FILES
========================= */

const CONFIG_FILE = "config.json";
const DATA_FILE = "blockedChannels.json";

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    global: { enabled: true, mode: "youtube" },
    countries: {}
  }, null, 2));
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}

/* =========================
   CONFIG ENDPOINTS
========================= */

app.get("/config", (req, res) => {
  const data = fs.readFileSync(CONFIG_FILE);
  res.json(JSON.parse(data));
});

app.post("/config", (req, res) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2));
  res.json({ message: "Config updated successfully" });
});

/* =========================
   BLOCKED CHANNELS
========================= */

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

/* =========================
   YOUTUBE API
========================= */

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

if (!YOUTUBE_API_KEY) {
  console.error("YOUTUBE_API_KEY bulunamadı!");
  process.exit(1);
}

/* =========================
   TOP50 CACHE
========================= */

let top50Cache = null;
let top50CacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000;

app.get("/top50", async (req, res) => {

  try {

    const now = Date.now();

    if (top50Cache && (now - top50CacheTime < CACHE_DURATION)) {
      return res.json({ source: "cache", data: top50Cache });
    }

    const response = await axiosClient.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "snippet,contentDetails,statistics",
          chart: "mostPopular",
          regionCode: "US",
          maxResults: 50,
          videoCategoryId: 10,
          key: YOUTUBE_API_KEY
        }
      }
    );

    top50Cache = response.data.items;
    top50CacheTime = now;

    res.json({ source: "youtube", data: top50Cache });

  } catch (error) {

    console.error(error.message);
    res.status(500).json({ error: "YouTube API error" });

  }

});

/* =========================
   SEARCH CACHE
========================= */

let searchCache = new Map();
const MAX_CACHE = 100;
const SEARCH_CACHE_DURATION = 60 * 60 * 1000;

app.get("/search", searchLimiter, async (req, res) => {

  try {

    const query = req.query.q?.toLowerCase().trim();

    if (!query) {
      return res.status(400).json({ error: "Query required" });
    }

    const pageToken = req.query.pageToken || "";
    const cacheKey = query + "_" + pageToken;
    const now = Date.now();

    if (searchCache.has(cacheKey)) {

      const cached = searchCache.get(cacheKey);

      if (now - cached.time < SEARCH_CACHE_DURATION) {
        return res.json(cached.data);
      }

      searchCache.delete(cacheKey);
    }

    const response = await axiosClient.get(
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
    );

    const result = {
      nextPageToken: response.data.nextPageToken,
      data: response.data.items
    };

    searchCache.set(cacheKey, { data: result, time: now });

    if (searchCache.size > MAX_CACHE) {
      const firstKey = searchCache.keys().next().value;
      searchCache.delete(firstKey);
    }

    res.json(result);

  } catch (error) {

    console.error(error.message);
    res.status(500).json({ error: "Search failed" });

  }

});

/* =========================
   STREAM
========================= */

app.get("/stream", async (req, res) => {

  try {

    const { videoId, type } = req.query;

    if (!videoId) {
      return res.status(400).json({ error: "videoId required" });
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const format = type === "audio" ? "bestaudio" : "best";

    const streamUrl = await ytdlp(youtubeUrl, {
      format: format,
      getUrl: true
    });

    if (!streamUrl) {
      return res.status(500).json({ error: "Stream resolve failed" });
    }

    const finalUrl = streamUrl.toString().trim();

    const response = await axios({
      method: "GET",
      url: finalUrl,
      responseType: "stream",
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    res.setHeader("Content-Type", response.headers["content-type"]);
    res.setHeader("Content-Length", response.headers["content-length"] || "");

    response.data.pipe(res);

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: "Streaming failed" });

  }

});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});

/* =========================
   RAILWAY KEEP ALIVE
========================= */

setInterval(async () => {

  try {

    await axiosClient.get(
      "https://ringtone-production.up.railway.app/health"
    );

    console.log("Server warm");

  } catch {}

}, 240000);