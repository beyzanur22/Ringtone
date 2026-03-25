const axios = require('axios');

const COBALT_INSTANCES = [
  "https://co.wuk.sh",
  "https://cobalt-api.peppe8o.com",
  "https://cobalt.q-n.cc",
  "https://cobalt.catterall.info"
];

async function testCobalt() {
  const url = "https://www.youtube.com/watch?v=e__YaECyqTI";
  for (const instance of COBALT_INSTANCES) {
    console.log("Testing:", instance);
    try {
      const res = await axios.post(`${instance}/api/json`, {
        url: url,
        downloadMode: "audio"
      }, {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        },
        timeout: 15000
      });
      console.log(`[SUCCESS] ${instance}:`, res.data.url ? res.data.url : res.data);
    } catch (e) {
      console.error(`[ERROR] ${instance}:`, e.response?.status, e.response?.data?.error?.code || e.message);
    }
  }
}
testCobalt();
