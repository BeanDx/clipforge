// Копирует правила моментов из приложения в сайт (site/moments.js), чтобы разбор демки на сайте
// считал баллы ровно как clipforge. Запуск из корня репозитория: node site/sync-moments.mjs
import { readFileSync, writeFileSync } from "node:fs";

let s = readFileSync("src/features/demo/moments.js", "utf8");
s = s.replace(/^import \{ tr \} from "..\/..\/i18n";\r?\n/m, "");
// tagLabel переводит метки через i18n приложения — на сайте свой перевод (main.js)
const a = s.indexOf("// метки хранятся по-русски"), b = s.indexOf("export function buildMoments");
if (a >= 0 && b > a) s = s.slice(0, a) + s.slice(b);
if (/\btr\(/.test(s)) throw new Error("moments.js uses tr() somewhere new — update site/sync-moments.mjs");
writeFileSync("site/moments.js", "// Копия src/features/demo/moments.js для разбора демки на сайте (без i18n приложения).\n// Обновляется командой: node site/sync-moments.mjs\n" + s);
console.log("site/moments.js updated");
