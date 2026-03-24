const play = require('play-dl');

async function test() {
  try {
    const stream = await play.stream('https://www.youtube.com/watch?v=IirESJ4AQlM');
    console.log("SUCCESS! URL:", stream.url);
  } catch (e) {
    console.log("FAIL:", e.message);
  }
}
test();
