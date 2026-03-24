const axios = require('axios');
async function find() {
    try {
        const inv = await axios.get("https://api.invidious.io/instances.json?sort_by=health");
        const workingInv = inv.data.filter(i => i[1].type === "https" && i[1].health > 90).map(i => i[1].uri);
        console.log("WORKING INVIDIOUS:", workingInv.slice(0, 10));

        const piped = await axios.get("https://raw.githubusercontent.com/TeamPiped/Piped/main/public-instances.json");
        const workingPiped = piped.data.map(i => i.api_url);
        console.log("WORKING PIPED:", workingPiped.slice(0, 10));
    } catch (e) { console.log(e.message); }
}
find();
