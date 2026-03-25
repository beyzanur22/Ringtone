const { Innertube, UniversalCache } = require("youtubei.js");

async function test() {
  try {
    const yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });
    console.log("Innertube initialized.");
    const vidId = "e__YaECyqTI";
    const info = await yt.getInfo(vidId);
    console.log("Title:", info.basic_info.title);

    try {
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });
      console.log("Audio Format found:", format.mime_type);
      console.log("FORMAT DUMP:", JSON.stringify(format, null, 2));
    } catch (e) {
      console.error("Format selection failed:", e.message);
    }
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}
test();
