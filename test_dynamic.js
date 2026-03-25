const axios = require('axios');

async function testDynamicInvidious() {
  const videoId = "e__YaECyqTI";
  try {
    const res = await axios.get("https://api.invidious.io/instances.json?sort_by=health");
    console.log("Raw Response 0:", res.data[0]);

    const instances = res.data
      .map(i => i[1]?.uri || `https://${i[0]}`)
      .slice(0, 5); 
      
    console.log("Found instances:", instances);
    
    for (const instance of instances) {
      console.log(`\nTesting instance: ${instance}`);
      try {
        const vRes = await axios.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 10000 });
        if (vRes.data && vRes.data.adaptiveFormats) {
          const m4a = vRes.data.adaptiveFormats.find(s => s.itag === "140");
          if (m4a) {
             const proxyUrl = `${instance}/latest_version?id=${videoId}&itag=140&local=true`;
             console.log("✅ SUCCESS URL:", proxyUrl);
             return;
          }
        }
      } catch (err) {
        console.log("❌ Failed:", err.message);
      }
    }
  } catch (e) {
    console.error("Failed:", e.message);
  }
}

testDynamicInvidious();
