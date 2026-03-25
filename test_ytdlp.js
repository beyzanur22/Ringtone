const ytdlp = require("yt-dlp-exec");

async function test() {
  try {
    const url = await ytdlp("https://www.youtube.com/watch?v=e__YaECyqTI", {
      format: "bestaudio",
      getUrl: true,
      cookies: "cookies.txt",
      extractorArgs: "youtube:player_client=web_embedded;player_skip=webpage"
    });
    console.log("yt-dlp success:", url);
  } catch (err) {
    console.error("yt-dlp failed:", err.message);
  }
}
test();
