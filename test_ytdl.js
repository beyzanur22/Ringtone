const ytdl = require('@distube/ytdl-core');

async function test() {
  try {
    const info = await ytdl.getInfo('https://www.youtube.com/watch?v=IirESJ4AQlM');
    // En iyi sesi (m4a/mp3) al:
    const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    console.log("SUCCESS URL:", audioFormat.url);
  } catch (err) {
    console.error("FAIL ERROR:", err.message);
  }
}
test();
