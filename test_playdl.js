const playdl = require("play-dl");
const fs = require("fs");

function parseCookiesToHeader(cookiePath) {
  try {
    const raw = fs.readFileSync(cookiePath, "utf8").replace(/^\uFEFF/, "").replace(/\r/g, "");
    const lines = raw.split("\n");
    const pairs = [];
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length >= 7) {
        const name = parts[5];
        const value = parts[6].trim();
        if (name) pairs.push(`${name}=${value}`);
      }
    }
    return pairs.join("; ");
  } catch (e) {
    return null;
  }
}

async function test() {
  const cookieHeader = parseCookiesToHeader("cookies.txt");
  if (cookieHeader) {
    playdl.setToken({ youtube: { cookie: cookieHeader } });
    console.log("play-dl cookies set.");
  }
  
  try {
    const info = await playdl.video_info("https://www.youtube.com/watch?v=e__YaECyqTI");
    console.log("play-dl success, formats found:", info.format.length);
  } catch(err) {
    console.error("play-dl failed:", err.message);
  }
}

test();
