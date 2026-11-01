// Перед сборкой установщика собирает src-tauri/parser: свой node.exe, скрипты разбора демок
// и demoparser2 с нативным модулем под Windows. Папка уходит в ресурсы программы (tauri.conf.json),
// поэтому установленному clipforge не нужен ни Node.js на компьютере, ни исходники проекта.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "src-tauri", "parser");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "scripts"), { recursive: true });

// Node, которым запущен этот скрипт, и становится Node программы
fs.copyFileSync(process.execPath, path.join(out, "node.exe"));

for (const f of fs.readdirSync(path.join(root, "scripts"))) {
  if (f.endsWith(".cjs") && f !== "bundle-parser.cjs") {
    fs.copyFileSync(path.join(root, "scripts", f), path.join(out, "scripts", f));
  }
}

// только то, что нужно для require("@laihoe/demoparser2") на Windows x64
const pkgs = {
  "@laihoe/demoparser2": ["index.js", "package.json"],
  "@laihoe/demoparser2-win32-x64-msvc": ["demoparser2.win32-x64-msvc.node", "package.json"],
};
for (const [pkg, files] of Object.entries(pkgs)) {
  const from = path.join(root, "node_modules", pkg);
  const to = path.join(out, "node_modules", pkg);
  fs.mkdirSync(to, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(from, f), path.join(to, f));
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`parser bundle: ${(size(out) / 1e6).toFixed(1)} MB (node ${process.version})`);
