const axios = require("axios");

async function testCobalt() {
  const url = "https://www.youtube.com/watch?v=NgRnbfWQmvw";
  const instances = ["https://api.cobalt.tools"];
  
  for (const instance of instances) {
    try {
      console.log(`Testing ${instance}...`);
      const payload = {
        url: url,
        videoQuality: "720",
        downloadMode: "audio",
        audioFormat: "mp3",
        youtubeVideoCodec: "h264"
      };
      
      const res = await axios.post(`${instance}/`, payload, {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });
      console.log("SUCCESS:", res.data);
    } catch (err) {
      console.error("ERROR from", instance);
      console.error("Status:", err.response?.status);
      console.error("Data:", err.response?.data);
      console.error("Message:", err.message);
    }
  }
}

testCobalt();
