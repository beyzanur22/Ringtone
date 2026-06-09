/**
 * ═══════════════════════════════════════════════════
 * MELODIA — GitHub Webhook Deploy Sunucusu
 *
 * GitHub'dan push geldiğinde admin panel otomatik build edilir.
 * Port 9000'de çalışır, PM2 ile başlatılır.
 *
 * GitHub Webhook ayarı:
 *   URL: http://173.212.249.105:9000/deploy
 *   Content type: application/json
 *   Secret: (WEBHOOK_SECRET env'den)
 *   Events: Push
 * ═══════════════════════════════════════════════════
 */

const http = require("http");
const { execFile } = require("child_process");
const crypto = require("crypto");

const PORT = process.env.WEBHOOK_PORT || 9000;
const SECRET = process.env.WEBHOOK_SECRET || "melodia-deploy-2026";
const DEPLOY_SCRIPT = "/opt/app/deploy-admin.sh";

let deploying = false;

function verifySignature(payload, signature) {
  if (!SECRET || !signature) return !SECRET; // Secret yoksa doğrulama atla
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end("OK");
  }

  // Deploy endpoint
  if (req.method === "POST" && req.url === "/deploy") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      // GitHub signature doğrulama
      const sig = req.headers["x-hub-signature-256"];
      if (SECRET && !verifySignature(body, sig)) {
        console.log("❌ Geçersiz webhook signature");
        res.writeHead(403);
        return res.end("Invalid signature");
      }

      // Zaten deploy ediyorsa beklet
      if (deploying) {
        console.log("⏳ Deploy zaten devam ediyor, atlanıyor...");
        res.writeHead(200);
        return res.end("Deploy already in progress");
      }

      deploying = true;
      console.log(`\n${"═".repeat(50)}`);
      console.log(`🚀 Deploy tetiklendi — ${new Date().toISOString()}`);

      // Deploy script'i çalıştır
      execFile("bash", [DEPLOY_SCRIPT], {
        timeout: 300000, // 5dk max
        env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" }
      }, (error, stdout, stderr) => {
        deploying = false;
        if (error) {
          console.error("❌ Deploy başarısız:", error.message);
          if (stderr) console.error(stderr);
        } else {
          console.log(stdout);
          console.log("✅ Deploy tamamlandı!");
        }
      });

      res.writeHead(200);
      res.end("Deploy started");
    });
    return;
  }

  // Manuel deploy tetikleme (tarayıcıdan)
  if (req.method === "GET" && req.url === "/deploy") {
    if (deploying) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Deploy zaten devam ediyor...");
    }

    deploying = true;
    console.log(`\n🔧 Manuel deploy tetiklendi — ${new Date().toISOString()}`);

    execFile("bash", [DEPLOY_SCRIPT], {
      timeout: 300000,
      env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" }
    }, (error, stdout, stderr) => {
      deploying = false;
      if (error) console.error("❌", error.message);
      else console.log(stdout);
    });

    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Deploy başlatıldı! Loglar: pm2 logs webhook");
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`
═══════════════════════════════════════════════════
  🔗 Webhook Deploy Sunucusu
  Port: ${PORT}
  Deploy URL: http://0.0.0.0:${PORT}/deploy
  Health: http://0.0.0.0:${PORT}/health
  Secret: ${SECRET ? "✅ Tanımlı" : "⚠️  Yok"}
═══════════════════════════════════════════════════
  `);
});
