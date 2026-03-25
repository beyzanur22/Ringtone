const { Innertube, UniversalCache } = require('youtubei.js');

async function testYoutubeI() {
  try {
    const yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });

    console.log("Fetching full info for: e__YaECyqTI");
    const info = await yt.getInfo("e__YaECyqTI");
    console.log("Title:", info.basic_info.title);

    const format = info.chooseFormat({ type: 'audio', quality: 'best' });
    console.log("✅ SUCCESS URL HEADERS:", format.url ? "Found" : "Missing");
    console.log("✅ URL:", format.decipher ? format.decipher(yt.session.player) : format.url);
  } catch (err) {
    console.error("❌ FAILED:", err.message);
  }
}

testYoutubeI();
