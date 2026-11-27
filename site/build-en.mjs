// Английская страница en/index.html из русской index.html: тексты из i18n.js (EN) подставляются
// прямо в разметку, чтобы поисковик видел английский без выполнения скриптов. Своя у неё только
// шапка (язык, title, description, canonical), файлы — общие, из корня (../).
// Деплой: node site/build-en.mjs _site  → _site/en/index.html. Локально serve.mjs собирает сам.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EN, UI } from "./i18n.js";

const SITE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://beandx.github.io/clipforge/";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// содержимое каждого элемента с data-i18n="key" → EN[key] (с конца, чтобы не сбить позиции)
function translate(html) {
  const hits = [...html.matchAll(/data-i18n="([^"]+)"/g)].reverse();
  for (const h of hits) {
    const key = h[1];
    if (EN[key] == null) continue;
    const open = html.lastIndexOf("<", h.index);
    const tag = /^<([a-zA-Z0-9-]+)/.exec(html.slice(open))[1];
    const start = html.indexOf(">", h.index) + 1;
    const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
    re.lastIndex = start;
    let depth = 1, m;
    while ((m = re.exec(html))) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (!depth) break;
    }
    if (!m) throw new Error(`не закрыт <${tag}> у ${key}`);
    html = html.slice(0, start) + EN[key] + html.slice(m.index);
  }
  return html;
}

export function buildEn(html) {
  const need = (from, to) => {
    if (!html.includes(from)) throw new Error(`build-en: в index.html нет «${from.slice(0, 60)}»`);
    html = html.replace(from, to);
  };
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(UI.en.title)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*/, `$1${esc(UI.en.desc)}`);
  html = html.replace(/(<meta property="og:title" content=")[^"]*/, "$1clipforge — CS2 demos to ready-made edits");
  html = html.replace(/(<meta property="og:description" content=")[^"]*/, "$1Smart moments, slow-mo, music with 3D lyrics, skins, victim POV. Free and open source.");
  need('<html lang="ru">', '<html lang="en">');
  need(`<meta property="og:url" content="${BASE}">`, `<meta property="og:url" content="${BASE}en/">`);
  need(`<link rel="canonical" href="${BASE}">`, `<link rel="canonical" href="${BASE}en/">`);
  need('href="style.css"', 'href="../style.css"');
  need('src="main.js"', 'src="../main.js"');
  need('src="media/reel.mp4" poster="media/reel.jpg"', 'src="../media/reel.mp4" poster="../media/reel.jpg"');
  need('href="en/" hreflang="en" aria-label="English version"', 'href="../" hreflang="ru" aria-label="Русская версия"');
  // заглушка до ответа GitHub и русские комментарии разметки
  html = html.replaceAll(">последний релиз<", `>${UI.en.latest}<`).replace(/\n?[ \t]*<!--[\s\S]*?-->/g, "");
  return translate(html);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(process.argv[2] || SITE, "en");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "index.html"), buildEn(readFileSync(join(SITE, "index.html"), "utf8")));
  console.log(`${join(out, "index.html")}`);
}
