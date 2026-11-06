// Локальный просмотр лендинга: node site/serve.mjs → http://localhost:4321
// Раскладывает файлы так же, как деплой (.github/workflows/pages.yml): site/* в корень,
// docs/screenshots/* → /shots/, docs/banner.webp → /banner.webp.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(SITE, "..", "docs");
const PORT = Number(process.env.PORT) || 4321;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".wasm": "application/wasm", ".md": "text/plain; charset=utf-8" };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const safe = normalize(p).replace(/^([\\/]*\.\.)+/, "");
  const file = safe.startsWith(`${join("/", "shots")}`) || safe.startsWith("/shots") ? join(DOCS, "screenshots", safe.replace(/^[\\/]shots/, ""))
    : /^[\\/]banner\.webp$/.test(safe) ? join(DOCS, "banner.webp")
    : join(SITE, safe);
  try {
    const body = await readFile(file);
    const head = { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store", "accept-ranges": "bytes" };
    // видео браузер просит кусками (Range) — без этого не работают перемотка и зацикливание
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      const a = m[1] ? Number(m[1]) : 0, b = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, { ...head, "content-range": `bytes ${a}-${b}/${body.length}`, "content-length": b - a + 1 });
      return res.end(req.method === "HEAD" ? undefined : body.subarray(a, b + 1));
    }
    res.writeHead(200, { ...head, "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.log(`Порт ${PORT} уже занят — скорее всего, сайт уже запущен: открой http://localhost:${PORT}`);
  console.log(`Или запусти на другом порту: set PORT=4322 && node site/serve.mjs`);
  process.exit(1);
}).listen(PORT, () => console.log(`clipforge site: http://localhost:${PORT}  (Ctrl+C — остановить)`));
