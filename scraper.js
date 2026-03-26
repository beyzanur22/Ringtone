const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
      ]
    });
  }
  return browser;
}

// Scrape yt1s.com (or similar) to get the direct download link
async function scrapeAudioUrl(videoId) {
  const b = await getBrowser();
  const page = await b.newPage();
  
  try {
    // We use a high timeout because third-party converters can be slow
    await page.goto('https://yt1s.com/en361/youtube-to-mp3', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Enter URL and click submit
    await page.waitForSelector('#s_input', { timeout: 10000 });
    await page.type('#s_input', `https://www.youtube.com/watch?v=${videoId}`);
    await page.click('#btn-submit');
    
    // Wait for the format dropdown/conversion to appear
    await page.waitForSelector('#btn-action', { timeout: 20000 });
    
    // The "Get link" button is #btn-action, click it to start conversion
    await page.click('#btn-action');
    
    // Wait for the final "Download" button that contains the actual href
    // Class typically changes to include btn-success and it will have a href attr
    await page.waitForSelector('#asuccess', { timeout: 45000, visible: true });
    
    // Extract the href
    const downloadUrl = await page.evaluate(() => {
      const a = document.querySelector('#asuccess');
      return a ? a.href : null;
    });
    
    if (downloadUrl) {
      console.log(`[SCRAPER] Successfully grabbed audio URL for ${videoId}`);
      return downloadUrl;
    }
    
    throw new Error("Could not find download URL in DOM");
  } catch (err) {
    console.error(`[SCRAPER] Failed to extract audio: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

module.exports = { scrapeAudioUrl };
