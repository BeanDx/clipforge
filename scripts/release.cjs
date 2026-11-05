// Релиз с автообновлением: подписанная сборка → latest.json → релиз на GitHub.
//
//   npm run release          собрать и выложить релиз v<версия из package.json>
//   npm run release -- --dry собрать и подготовить файлы, но ничего не выкладывать
//
// Нужно один раз:
//   1. npx tauri signer generate -w %USERPROFILE%\.tauri\clipforge.key
//      открытый ключ (вывод команды / файл clipforge.key.pub) → plugins.updater.pubkey в src-tauri/tauri.conf.json.
//      Секретный ключ никому не показывать и не коммитить: без него старые версии не смогут обновиться.
//   2. gh auth login
// Перед каждым релизом:
//   - поднять версию в package.json, src-tauri/tauri.conf.json и src-tauri/Cargo.toml;
//   - написать список изменений в release-notes/<версия>.md (markdown — его увидят в окне «Что нового»).
// Пароль ключа (если задан) — в переменной TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPO = "BeanDx/clipforge";
const dry = process.argv.includes("--dry");

const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const run = (cmd, opts = {}) => {
  const r = spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) fail(`команда не прошла: ${cmd}`);
};
const out = (cmd) => spawnSync(cmd, { cwd: ROOT, shell: true, encoding: "utf8" });

// --- проверки до долгой сборки ---
const version = require(path.join(ROOT, "package.json")).version;
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const cargo = fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (conf.version !== version || cargo !== version) {
  fail(`версии не совпадают: package.json ${version}, tauri.conf.json ${conf.version}, Cargo.toml ${cargo}`);
}
const pubkey = conf.plugins?.updater?.pubkey || "";
if (!pubkey || pubkey.startsWith("REPLACE_")) {
  fail("нет открытого ключа: вставь вывод `npx tauri signer generate` в plugins.updater.pubkey (src-tauri/tauri.conf.json)");
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const def = path.join(os.homedir(), ".tauri", "clipforge.key");
  if (!fs.existsSync(def)) fail(`нет секретного ключа: ни TAURI_SIGNING_PRIVATE_KEY, ни файла ${def}`);
  process.env.TAURI_SIGNING_PRIVATE_KEY = def;
}
const notesFile = path.join(ROOT, "release-notes", `${version}.md`);
if (!fs.existsSync(notesFile)) fail(`нет списка изменений: ${path.relative(ROOT, notesFile)}`);
const notes = fs.readFileSync(notesFile, "utf8").trim();
const tag = `v${version}`;
if (!dry) {
  if (out("gh auth status").status !== 0) fail("gh не авторизован: gh auth login");
  if (out(`gh release view ${tag} --repo ${REPO}`).status === 0) fail(`релиз ${tag} уже есть на GitHub — подними версию`);
}

// --- подписанная сборка: .sig рядом с установщиком появляется только с createUpdaterArtifacts ---
console.log(`\n▶ сборка clipforge ${version} с подписью обновлений\n`);
const extra = path.join(ROOT, "src-tauri", "target", "release-updater.conf.json");
fs.mkdirSync(path.dirname(extra), { recursive: true });
fs.writeFileSync(extra, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
run(`npx tauri build --config "${extra}"`);

const bundle = path.join(ROOT, "src-tauri", "target", "release", "bundle");
const setupName = `clipforge_${version}_x64-setup.exe`;
const setup = path.join(bundle, "nsis", setupName);
const sig = `${setup}.sig`;
const msi = path.join(bundle, "msi", `clipforge_${version}_x64_en-US.msi`);
if (!fs.existsSync(setup) || !fs.existsSync(sig)) fail(`не нашёл ${setupName} и .sig в ${path.relative(ROOT, path.dirname(setup))}`);

// --- latest.json: его читает программа (адрес в plugins.updater.endpoints) ---
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sig, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${setupName}`,
    },
  },
};
const latestFile = path.join(bundle, "latest.json");
fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2));
console.log(`\n✓ готово: ${path.relative(ROOT, setup)}, .sig, latest.json`);

if (dry) {
  console.log("  --dry: на GitHub ничего не выкладываю\n");
  process.exit(0);
}

// --- релиз на GitHub ---
const files = [setup, sig, latestFile, ...(fs.existsSync(msi) ? [msi] : [])].map((f) => `"${f}"`).join(" ");
run(`gh release create ${tag} ${files} --repo ${REPO} --title "clipforge ${version}" --notes-file "${notesFile}"`);
console.log(`\n✓ релиз ${tag} выложен. Установленные копии увидят обновление в течение 6 часов (или сразу — «Проверить обновления»).\n`);
