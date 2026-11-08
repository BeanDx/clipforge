// Починка демок FACEIT прямо на месте (логика — demofix.cjs, github.com/NewTanachot/cs2-faceit-demo-fixer).
// Питомец-курица (CChicken) спавнится вместе с игроками на первом тике, и её baseline попадает в первый
// пакет вместо signon-таблиц — CS2 падает сразу после playdemo. Фикс переносит baseline в signon и заодно
// заменяет битый UTF-8 в строках событий (на нём спотыкается demoparser2). Геймплей не меняется.
//
// Как модуль: fixInPlace(path) → null (чинить нечего) или { crash: ["CChicken"], text: N, error? }.
// Из командной строки: node fixdemo.cjs <demo.dem> — печатает тот же результат JSON (null, если чинить нечего).
const fs = require("fs");
const DemoFix = require("./demofix.cjs");

function fixInPlace(file) {
  let u8 = new Uint8Array(fs.readFileSync(file));
  if (DemoFix.detectFormat(u8) !== "dem") return null;
  let res;
  try { res = DemoFix.fixDemo(u8); } catch { return null; } // не смогли разобрать — пусть дальше скажет парсер
  if (!res.changed) return null;
  const r = res.report;
  const out = {
    crash: r.crashFix.applied ? r.crashFix.tables.flatMap((t) => t.added.map((a) => a.className || a.key)) : [],
    text: r.textFix.items.length,
  };
  // пишем рядом и подменяем одним rename: оборванная запись не испортит демку
  const tmp = file + ".fixing";
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(tmp, "w");
    try { for (const p of res.parts) fs.writeSync(fd, p); } finally { fs.closeSync(fd); }
    res = null; u8 = null;
    // дата файла остаётся прежней: по ней главная сопоставляет демку с матчем
    fs.utimesSync(tmp, st.atime, st.mtime);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    // например, демку прямо сейчас держит открытой CS2
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

module.exports = { fixInPlace };

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(fixInPlace(process.argv[2])));
  } catch (e) {
    process.stderr.write(String(e && e.message ? e.message : e));
    process.exit(1);
  }
}
