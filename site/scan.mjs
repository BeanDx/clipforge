// Пишет site/available.json — что из необязательного лежит в site/ (ролики, шторка, WASM-парсер).
// Сайт читает этот файл вместо проверок «есть ли файл» (они сыпали 404 в консоль).
// Вызывается сам из make-media.mjs и build-parser.cmd; вручную: node site/scan.mjs
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(fileURLToPath(import.meta.url));
const has = (p) => existsSync(join(SITE, p));
const out = {
  reel: Object.fromEntries(["ru", "en"].filter((l) => has(`media/reel-${l}.mp4`)).map((l) => [l, true])),
  beforeAfter: has("media/before.mp4") && has("media/after.mp4"),
  parser: has("parser/demoparser2.js") && has("parser/demoparser2_bg.wasm"),
};
writeFileSync(join(SITE, "available.json"), JSON.stringify(out, null, 2) + "\n");
console.log("site/available.json:", JSON.stringify(out));
