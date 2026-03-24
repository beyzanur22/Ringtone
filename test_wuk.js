const axios = require('axios');
axios.post('https://co.wuk.sh/api/json', {
    url: 'https://www.youtube.com/watch?v=IirESJ4AQlM',
    aFormat: "mp3",
    isAudioOnly: true
}, {
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://co.wuk.sh'
    }
}).then(r => console.log("SUCCESS:", r.data)).catch(e => console.log("FAIL:", e.response ? e.response.status : e.message));
