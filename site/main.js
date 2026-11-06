// Лендинг clipforge: языки, анимации при прокрутке, шаги «как работает», калькулятор баллов
// момента (те же правила, что src/features/demo/moments.js), актуальный релиз с GitHub.
import { CONFIG } from "./config.js";
import { buildMoments, tierOf } from "./moments.js";

const REPO = CONFIG.repo;
// что из необязательного есть рядом (site/scan.mjs) — без запросов к файлам, которых нет
const AVAIL = fetch("available.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- языки ----------
// русский текст — прямо в разметке, здесь только английский
const EN = {
  "nav.how": "How it works", "nav.score": "Moments", "nav.features": "Features", "nav.deps": "Requirements", "nav.faq": "FAQ", "nav.dl": "Download",
  "hero.kicker": "free · local · open source", "hero.t1": "CS2 demos", "hero.t2": "highlight edits", "hero.t3": "in one click",
  "hero.sub": "clipforge finds your best moments, records them in-game through HLAE and adds slow-mo, music with 3D lyrics, skins and a victim POV replay. No video editor needed.",
  "hero.dl": "Download for Windows", "hero.how": "How it works ↓", "hero.scroll": "scroll",
  "how.title": "From <code>.dem</code> to <code>.mp4</code>", "how.sub": "Five steps. You do two of them: drop a demo and press F10.",
  "st.kills": "kills", "st.rounds": "rounds", "st.players": "players", "st.f10": "start recording",
  "s0.t": "Drop a demo", "s0.d": "FACEIT, matchmaking, Premier or SourceTV from community servers. FACEIT demos can be downloaded right inside the app.",
  "s1.t": "The demo is parsed", "s1.d": "demoparser2 pulls every kill, damage event, position, round and loadout. Plus a match dossier: crosshair codes, counter-strafing, TTK, opening duels.",
  "s2.t": "Moments pick themselves", "s2.d": "Every round of every player gets a score: multi-kills, real 1vN clutches, wallbangs, no-scopes, ecos, ninja defuses. The best are already selected.",
  "s3.t": "CS2 records the frames", "s3.d": "The game launches through HLAE, you press F10 and frames are recorded straight from the engine. Alt-tab and do something else meanwhile.",
  "s4.t": "ffmpeg builds the edit", "s4.d": "Slow-mo, music, 3D lyrics, kill flashes, headshot zoom and the victim POV replay. You get a notification, the clip is in the gallery.",
  "sc.title": "Build your own moment", "sc.sub": "The same rules and points clipforge uses inside. Try to reach Legendary.",
  "sc.kills": "kills this round", "sc.hs": "headshots", "sc.clutch": "clutch", "sc.none": "no", "sc.style": "how", "sc.result": "moment score",
  "tg.wall": "wallbang", "tg.smoke": "through smoke", "tg.air": "mid-air", "tg.blind": "while blind", "tg.knife": "knife", "tg.fast": "within 3 s",
  "tg.opening": "opening kill", "tg.eco": "on an eco", "tg.decisive": "deciding round", "tg.ninja": "ninja defuse",
  "ft.title": "Looks like an edit, not a screen recording",
  "f1.t": "Smart moment picking", "f1.d": "Multi-kills with a speed bonus, 1vN clutches, wallbangs, no-scopes, ecos and pistol rounds. Tiers from Good to Legendary.",
  "f2.t": "Slow-mo, flashes, beat", "f2.d": "Smooth slow motion around kills, audio through Rubber Band, kill flash, headshot zoom, shake on the bass.",
  "f3.t": "3D lyrics in the map", "f3.d": "Lyrics come from LRCLIB or get timed by a local Whisper. They float inside the map, the chorus lands on your last kill.",
  "f4.t": "Through the victim's eyes", "f4.d": "After the clip every kill replays from the POV of the player you killed. Plus an orbit camera after the final kill.",
  "f5.t": "Any skins", "f5.d": "Weapons, knife and gloves are swapped in a copy of the demo. Your inventory and game files stay untouched.",
  "f6.t": "Match dossier and player card", "f6.d": "One-click crosshair codes, accuracy, counter-strafing, TTK, opening duels. A 1080×1920 card for stories and Discord.",
  "f7.t": "Gallery and before / after", "f7.d": "Every clip with previews, filters and a player. A slider: raw demo vs the finished clip.",
  "f8.t": "Doesn't get in the way", "f8.d": "Live match data, highlight bookmarks on F8, tray mode. In game clipforge barely uses anything: 1005 vs 977 FPS.",
  "sh.title": "Inside the app", "sh.demo": "Demo", "sh.moments": "Moments", "sh.fx": "Effects", "sh.gallery": "Highlights", "sh.overlay": "Over the game", "sh.settings": "Settings",
  "dp.title": "Requirements", "dp.sub": "The app installs almost everything itself. You need Windows and CS2.",
  "dp.need": "required", "dp.auto": "downloads itself", "dp.in": "in the installer", "dp.sys": "already in Windows", "dp.opt": "optional",
  "dp.win": "64-bit", "dp.cs": "From Steam, found automatically", "dp.hlae": "Records frames from the engine", "dp.ff": "Builds the video, NVENC / AMF / Quick Sync",
  "dp.node": "Demo parsing", "dp.wv": "The app's interface", "dp.wh": "Times song lyrics, ~170 MB on first use", "dp.fc": "FACEIT levels and elo, free key",
  "dl.title": "Grab it, it's free", "dl.btn": "Download installer", "dl.msi": "MSI package", "dl.all": "all releases", "dl.src": "source code",
  "dl.note": "Updates arrive inside the app on their own.",
  "fq.title": "FAQ",
  "q1": "Will I get VAC banned?", "a1": "CS2 starts through HLAE with <code>-insecure</code>: VAC is off for that session and you can't join secured servers with it. clipforge only plays demos on your PC. The game closes itself after the render. Before matchmaking, just start CS2 as usual.",
  "q2": "Does FPS drop with the app open?", "a2": "Barely: 1005 vs 977 FPS on average, about 3%, within normal variance. While you're in game clipforge pauses its animations and uses ~0% CPU and ~270 MB of RAM.",
  "q3": "Which demos work?", "a3": "CS2 demos from FACEIT, Valve matchmaking and Premier, and SourceTV demos from community servers.",
  "q4": "Can anyone see the changed skins?", "a4": "No. clipforge writes a modified copy of the demo and records from it. Your inventory, the game and the original demo stay as they were.",
  "q5": "Do I need a FACEIT API key?", "a5": "No. It's only for FACEIT levels and elo. Everything else works without it.",
  "q6": "How much does it cost?", "a6": "Nothing. clipforge is free and open source under MIT. Video renders on your own PC: no queues, no subscriptions, no quality limits.",
  "q7": "Is it an Allstar or Medal alternative?", "a7": "Same goal: CS2 highlights without manual editing. The difference is that clipforge works from the demo on your own PC: no server queue and no subscription, any resolution and FPS. Plus things you usually don't get: music with 3D lyrics, skin changes and a victim POV replay.",
  "foot": "MIT · not affiliated with Valve. Counter-Strike is a trademark of Valve Corporation.",
  "rl.title": "This is the result", "rl.sub": "Not edited in a video editor. A demo, the Night Edit preset and one button.",
  "ba.before": "raw demo", "ba.after": "clipforge",
  "rl.note": "Lyrics in any language — this edit uses a Russian track",
  "dm.title": "Drop your own demo", "dm.sub": "Parsing happens right in your browser, the file is never uploaded. See your best moments the way clipforge sees them.",
  "dm.drop": "drag it here or click", "dm.where": "FACEIT, matchmaking, Premier, SourceTV", "dm.player": "player",
  "dm.cta": "To turn these moments into a video with effects and music, you need the app.", "dm.btn": "Download clipforge", "dm.again": "another demo",
  "ly.title": "Lyrics right inside the map", "ly.sub": "Type a line and it stands up in 3D like in a clip: word by word, on the beat.",
  "ly.accent": "accent", "ly.neon": "neon", "ly.clean": "clean", "ly.go": "▶ play",
  "in.title": "Install in a minute", "in.1t": "Run the installer", "in.1d": "The <code>clipforge_x.y.z_x64-setup.exe</code> file from Downloads.",
  "in.2t": "Windows may warn you", "in.2d": "The installer doesn't have a paid code-signing certificate yet, so SmartScreen shows a blue window. Click <b>More info</b>, then <b>Run anyway</b>.",
  "ss.h": "Windows protected your PC", "ss.p": "Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.",
  "ss.more": "More info", "ss.app": "App:", "ss.pub": "Publisher:", "ss.unk": "Unknown publisher", "ss.run": "Run anyway", "ss.no": "Don't run",
  "in.3t": "Check the file if you like", "in.3d": "The hash should match the one above. In PowerShell:", "in.copy": "copy", "in.3e": "The source is open: you can build the installer yourself.",
  "in.4t": "Open a demo", "in.4d": "HLAE and ffmpeg download themselves on first launch and CS2 paths are found automatically. Drop a <code>.dem</code> on the Demo tab.",
  "nw.title": "What's new", "nw.sub": "clipforge updates often. The latest releases from GitHub:", "nw.all": "full release history →",
  "cm.title": "Join in", "cm.sub": "Share your clips, suggest features, report bugs.",
};
const UI = {
  ru: { copied: "скопировано", newest: "новое", more: "показать полностью", less: "свернуть", demoStages: { load: "загружаю парсер...", read: "читаю файл...", header: "заголовок...", deaths: "киллы...", rounds: "раунды...", teams: "составы и экипировка...", defuses: "дефьюзы...", score: "считаю моменты..." },
    demoErr: "Не получилось разобрать демку: {0}. Попробуй другую или открой её в приложении.", noMoments: "У этого игрока нет моментов, которые попали бы в клипы.", moments: "{0} моментов", round: "раунд",
    lyr: "Я собрал тебя заново из кусков", mb: "МБ", latest: "последний релиз", tiers: ["Обычный", "Хорошо", "Топ", "Эпик", "Легенда"], skip: "одиночный фраг попадёт в клипы от 22 баллов",
    noClip: "такой момент не попадёт в клипы", inClip: "попадёт в клипы", title: "clipforge — хайлайты CS2 из демок в один клик, бесплатно", desc: "Бесплатная программа для хайлайтов CS2: кидаешь демку, получаешь готовый эдит для TikTok и YouTube. Умная выборка моментов, slow-mo, музыка с 3D-текстом песни, скины, повтор глазами убитого. Локально, без подписки, open source.", fast: (s) => `за ${s} с`, m: "м" },
  en: { copied: "copied", newest: "new", more: "show all", less: "collapse", demoStages: { load: "loading the parser...", read: "reading the file...", header: "header...", deaths: "kills...", rounds: "rounds...", teams: "teams and loadouts...", defuses: "defuses...", score: "scoring moments..." },
    demoErr: "Couldn't parse this demo: {0}. Try another one or open it in the app.", noMoments: "This player has no moments that would make the clips.", moments: "{0} moments", round: "round",
    lyr: "Built you again from the pieces", mb: "MB", latest: "latest release", tiers: ["Ordinary", "Good", "Top", "Epic", "Legendary"], skip: "a single kill makes the clips from 22 points",
    noClip: "this moment won't make the clips", inClip: "makes the clips", title: "clipforge — free CS2 highlight maker: demos to edits in one click", desc: "Free CS2 highlight maker: drop a demo, get a ready-to-post edit for TikTok and YouTube. Smart moment picking, slow-mo, music with 3D lyrics, skins, victim POV replay. Local, no subscription, open source.", fast: (s) => `in ${s} s`, m: "m" },
};
const RU = {};
$$("[data-i18n]").forEach((el) => { RU[el.dataset.i18n] = el.innerHTML; });

// язык: ?lang= в адресе (так поисковики видят обе версии) → выбор посетителя → язык системы
let lang = (() => {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "ru" || q === "en") return q;
  try { const s = localStorage.getItem("cf-site-lang"); if (s === "ru" || s === "en") return s; } catch { /* приватный режим */ }
  return /^(ru|uk|be|kk)/i.test(navigator.language || "") ? "ru" : "en";
})();
let scene = null;

function applyLang(l) {
  lang = l;
  document.documentElement.lang = l;
  document.title = UI[l].title;
  document.querySelector('meta[name="description"]').content = UI[l].desc;
  document.querySelector('link[rel="canonical"]').href = `https://beandx.github.io/clipforge/?lang=${l}`;
  // адрес меняется без перезагрузки, чтобы ссылкой делились на нужном языке
  const u = new URL(location.href);
  if (u.searchParams.get("lang") !== l) { u.searchParams.set("lang", l); history.replaceState(null, "", u); }
  $$("[data-i18n]").forEach((el) => {
    const v = l === "en" ? EN[el.dataset.i18n] : RU[el.dataset.i18n];
    if (v != null && el.innerHTML !== v) el.innerHTML = v;
  });
  $$("#lang b").forEach((b) => b.classList.toggle("on", b.dataset.l === l));
  $$("img[data-shot]").forEach((img) => { img.src = `shots/${img.dataset.shot}-${l}.webp`; });
  scene?.setLang(l);
  try { localStorage.setItem("cf-site-lang", l); } catch { /* не страшно */ }
  renderRelease();
  renderNews();
  renderDemo();
  setReel(l);
  score();
  if (lyr && !lyrTouched) { $("#lyrInput").value = UI[l].lyr; playLyrics(); }
}
const fmt = (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[i]);
$("#lang").addEventListener("click", () => applyLang(lang === "ru" ? "en" : "ru"));

// ---------- 3D ----------
(async () => {
  const canvas = $("#scene");
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) throw new Error("no webgl2");
    const { startScene } = await import("./scene.js");
    scene = startScene(canvas, { lang });
  } catch (e) {
    console.warn("3D off:", e);
    document.documentElement.classList.add("no-webgl");
  }
})();
$$(".js-dl").forEach((a) => a.addEventListener("pointerenter", () => scene?.hit()));

// ---------- появление при прокрутке ----------
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } }), { threshold: 0.12 });
$$(".reveal").forEach((el, i) => { el.style.setProperty("--d", `${(i % 4) * 0.06}s`); io.observe(el); });

// навигация: фон после героя, подсветка текущей секции
const nav = $("#nav");
addEventListener("scroll", () => nav.classList.toggle("is-solid", scrollY > 40), { passive: true });
const links = $$(".nav__links a");
const secIo = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) links.forEach((a) => a.classList.toggle("is-on", a.getAttribute("href") === `#${e.target.id}`));
}), { rootMargin: "-45% 0px -50% 0px" });
$$("section[id]").forEach((s) => secIo.observe(s));

// ---------- как работает ----------
const stage = $("#stage"), dots = $$("#howDots li");
// шкала раундов: 24 столбика, несколько хайлайтов
const TIER_AT = { 6: "t-epic", 13: "t-legend", 18: "t-top", 3: "t-good", 21: "t-good", 9: "t-good" };
$(".rounds__bars").innerHTML = Array.from({ length: 24 }, (_, i) => {
  const t = TIER_AT[i];
  const h = t === "t-legend" ? 100 : t === "t-epic" ? 78 : t === "t-top" ? 58 : t ? 38 : 8 + ((i * 37) % 22);
  return `<i class="${t || ""}" style="--h:${h}%;--i:${i}"></i>`;
}).join("");

let countT = null, recT = null;
function setStep(i) {
  if (stage.dataset.step === String(i)) return;
  stage.dataset.step = i;
  dots.forEach((d, k) => d.classList.toggle("on", k <= i));
  $$(".step").forEach((s) => s.classList.toggle("on", Number(s.dataset.i) === i));
  // перезапуск CSS-анимаций шага
  $$(`.st-${i} *`).forEach((el) => { el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; });
  clearInterval(countT); clearInterval(recT);
  if (i === 1) {
    const els = $$("[data-count]"), t0 = performance.now();
    countT = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / 1200), e = 1 - Math.pow(1 - k, 3);
      els.forEach((el) => { el.textContent = Math.round(Number(el.dataset.count) * e); });
      if (k >= 1) clearInterval(countT);
    }, 30);
  }
  if (i === 3) {
    const el = $(".rec__frames b"); let f = 0;
    recT = setInterval(() => { f += 7; el.textContent = String(f).padStart(5, "0"); }, 60);
  }
}
// текущий шаг — тот, чей центр ближе всего к линии на 45% высоты экрана (надёжнее наблюдателя при быстрой прокрутке)
const stepEls = $$(".step");
let stepRaf = 0;
const pickStep = () => {
  stepRaf = 0;
  const line = innerHeight * 0.45;
  let best = 0, bestD = Infinity;
  stepEls.forEach((s, i) => {
    const r = s.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - line);
    if (d < bestD) { bestD = d; best = i; }
  });
  setStep(best);
};
addEventListener("scroll", () => { stepRaf ||= requestAnimationFrame(pickStep); }, { passive: true });
addEventListener("resize", pickStep);
setStep(0);
pickStep();

// ---------- калькулятор баллов (src/features/demo/moments.js) ----------
const P = { kill: 10, hs: 4, wall: 8, smoke: 6, noscope: 12, air: 8, blind: 10, knife: 15, multi: { 2: 8, 3: 22, 4: 45, 5: 90 },
  fast: 14, allHs: 10, opening: 5, clutchPerEnemy: 20, eco: 5, decisive: 10, ninja: 25 };
const TIERS = [[130, "legend", 4], [80, "epic", 3], [45, "top", 2], [25, "good", 1], [0, "ok", 0]];
const TIER_C = { legend: "var(--legend)", epic: "var(--epic)", top: "var(--top)", good: "var(--good)", ok: "var(--dim)" };
const TAG = {
  ru: { wall: "сквозь стену", smoke: "через смок", noscope: "no-scope", air: "в прыжке", blind: "ослеплённым", knife: "ножом", opening: "открытие", eco: "эко", decisive: "решающий раунд", ninja: "ниндзя-дефьюз", allHs: "все в голову", clutch: (n) => `клатч 1v${n}` },
  en: { wall: "wallbang", smoke: "through smoke", noscope: "no-scope", air: "mid-air", blind: "while blind", knife: "knife", opening: "opening", eco: "eco", decisive: "deciding round", ninja: "ninja defuse", allHs: "all headshots", clutch: (n) => `clutch 1v${n}` },
};
const st = { kills: 3, hs: 2, clutch: 0, on: new Set(["fast"]) };
const kills = $("#kills"), hs = $("#hs");
let shown = 0, lastTier = "";

function score() {
  const n = st.kills, T = TAG[lang];
  st.hs = Math.min(st.hs, n);
  hs.max = n; hs.value = st.hs;
  $("#killsV").textContent = n; $("#hsV").textContent = st.hs;
  $$("#toggles button").forEach((b) => {
    const k = b.dataset.k;
    b.disabled = k === "fast" && n < 2;
    b.classList.toggle("on", st.on.has(k) && !b.disabled);
    b.setAttribute("aria-pressed", b.classList.contains("on"));
  });
  const on = (k) => st.on.has(k) && !(k === "fast" && n < 2);

  let s = n * P.kill + st.hs * P.hs;
  const tags = [];
  for (const k of ["wall", "smoke", "noscope", "air", "blind", "knife"]) if (on(k)) { s += P[k]; tags.push(T[k]); }
  if (n >= 2) s += P.multi[n];
  if (on("fast")) { s += P.fast; tags.push(UI[lang].fast((1.2 + n * 0.35).toFixed(1))); }
  if (n >= 3 && st.hs === n) { s += P.allHs; tags.push(T.allHs); }
  if (on("opening")) { s += P.opening; tags.push(T.opening); }
  if (st.clutch) { s += P.clutchPerEnemy * st.clutch; tags.push(T.clutch(st.clutch)); }
  if (on("eco")) { s += P.eco * n; tags.push(T.eco); }
  if (on("decisive")) { s += P.decisive; tags.push(T.decisive); }
  if (on("ninja")) { s += P.ninja; tags.push(T.ninja); }
  const lead = n >= 5 ? "ACE" : n >= 2 ? `${n}K` : null;
  if (lead) tags.unshift(lead);

  const [, tier, ti] = TIERS.find(([min]) => s >= min);
  const inClips = n >= 2 || st.clutch || on("ninja") || s >= 22;
  const out = $("#scoreOut");
  out.style.setProperty("--tc", TIER_C[tier]);
  $(".scorer").classList.toggle("is-legend", tier === "legend");
  const tierEl = $("#scoreTier");
  tierEl.textContent = UI[lang].tiers[ti];
  if (tier !== lastTier) { tierEl.classList.remove("bump"); void tierEl.offsetWidth; tierEl.classList.add("bump"); lastTier = tier; }
  $("#meterFill").style.width = `${Math.min(100, (s / 180) * 100)}%`;
  $("#scoreTags").innerHTML = tags.map((t) => `<span>${t}</span>`).join("");
  $("#scoreNote").textContent = inClips ? `✓ ${UI[lang].inClip}` : n === 1 ? UI[lang].skip : UI[lang].noClip;
  animateNum(s);
}
function animateNum(to) {
  const el = $("#scoreNum"), from = shown, t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 450);
    shown = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    el.textContent = shown;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
kills.addEventListener("input", () => { st.kills = Number(kills.value); score(); });
hs.addEventListener("input", () => { st.hs = Number(hs.value); score(); });
$$("#clutch button").forEach((b) => b.addEventListener("click", () => {
  st.clutch = Number(b.dataset.v);
  $$("#clutch button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
  score();
}));
$$("#toggles button").forEach((b) => b.addEventListener("click", () => {
  const k = b.dataset.k;
  st.on.has(k) ? st.on.delete(k) : st.on.add(k);
  score();
}));

// ---------- карточки: наклон за мышью ----------
if (matchMedia("(hover: hover)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  $$(".tilt").forEach((c) => {
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      c.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 6}deg) rotateY(${(x - 0.5) * 8}deg) translateY(-4px)`;
      c.style.setProperty("--mx", `${x * 100}%`); c.style.setProperty("--my", `${y * 100}%`);
    });
    c.addEventListener("pointerleave", () => { c.style.transform = ""; });
  });
}

// ---------- скриншоты ----------
$$("#shotTabs button").forEach((b) => b.addEventListener("click", () => {
  $$("#shotTabs button").forEach((x) => x.classList.toggle("on", x === b));
  const img = $("#shotImg");
  img.classList.add("swap");
  setTimeout(() => {
    img.dataset.shot = b.dataset.s;
    img.src = `shots/${b.dataset.s}-${lang}.webp`;
    img.onload = () => img.classList.remove("swap");
  }, 180);
}));

// ---------- релиз и звёзды с GitHub ----------
let release = null;
function renderRelease() {
  if (!release) { $$(".js-ver").forEach((e) => { if (e.closest(".btn")) e.textContent = UI[lang].latest; }); return; }
  const exe = release.assets.find((a) => /_x64-setup\.exe$/.test(a.name));
  const msi = release.assets.find((a) => /\.msi$/.test(a.name));
  const date = new Date(release.published_at).toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "long", year: "numeric" });
  $$(".js-ver").forEach((e) => { e.textContent = release.tag_name + (e.closest(".btn") ? ` · ${exe ? (exe.size / 1048576).toFixed(1) + " " + UI[lang].mb : ""}` : ""); });
  $$(".js-date").forEach((e) => { e.textContent = date; });
  if (exe) {
    $$(".js-dl").forEach((a) => { a.href = exe.browser_download_url; });
    $$(".js-file").forEach((e) => { e.textContent = exe.name; });
    $$(".js-size").forEach((e) => { e.textContent = `${(exe.size / 1048576).toFixed(1)} ${UI[lang].mb}`; });
    $$(".js-hash").forEach((e) => { e.textContent = exe.digest?.replace(/^sha256:/, "") || "—"; });
  }
  if (msi) $$(".js-msi").forEach((a) => { a.href = msi.browser_download_url; });
}
// один запрос: последний релиз для кнопки и три последних для «Что нового»
let releases = [];
fetch(`https://api.github.com/repos/${REPO}/releases?per_page=6`)
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((list) => {
    releases = list.filter((x) => !x.draft && !x.prerelease).slice(0, 3);
    release = releases[0] || null;
    renderRelease(); renderNews();
  })
  .catch(() => { /* ссылки остаются на releases/latest, «Что нового» скрыт */ });

// ---------- что нового ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// маленький разбор markdown из описания релиза: заголовки, списки, жирный, код, ссылки
function md(src) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let out = "", list = false;
  for (const raw of String(src || "").split(/\r?\n/)) {
    const l = raw.trim();
    if (/^[-*] /.test(l)) { if (!list) { out += "<ul>"; list = true; } out += `<li>${inline(l.slice(2))}</li>`; continue; }
    if (list) { out += "</ul>"; list = false; }
    if (!l || /^<!--/.test(l) || /^!\[/.test(l)) continue;
    const h = /^#{1,4} (.*)/.exec(l);
    out += h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(l)}</p>`;
  }
  return out + (list ? "</ul>" : "");
}
function renderNews() {
  const box = $("#newsList");
  if (!releases.length) return;
  $("#news").hidden = false;
  numberSections();
  const loc = lang === "ru" ? "ru-RU" : "en-US";
  box.innerHTML = releases.map((r, i) => `
    <article class="rel ${i ? "is-cut" : ""}">
      <div class="rel__meta"><b>${esc(r.tag_name)}</b><span class="mono">${new Date(r.published_at).toLocaleDateString(loc, { day: "numeric", month: "long", year: "numeric" })}</span>${i ? "" : `<span class="rel__new mono">${UI[lang].newest}</span>`}</div>
      <div class="rel__body">${md(r.body) || `<p>${esc(r.name || r.tag_name)}</p>`}</div>
      ${i ? `<button type="button" class="rel__more">${UI[lang].more}</button>` : ""}
    </article>`).join("");
  $$(".rel__more", box).forEach((b) => b.addEventListener("click", () => {
    const a = b.closest(".rel"); a.classList.toggle("is-cut");
    b.textContent = a.classList.contains("is-cut") ? UI[lang].more : UI[lang].less;
  }));
}

// номера секций по порядку — с учётом скрытых блоков
function numberSections() {
  let n = 0;
  $$("main .sec").forEach((s) => { const el = $(".sec__num", s); if (el && !s.hidden) el.textContent = String(++n).padStart(2, "0"); });
}

// ---------- шоурил и шторка «до / после» ----------
const reelV = $("#reelVideo");
reelV.addEventListener("error", () => { $("#reel").hidden = true; numberSections(); }, { once: true });
// свой ролик для языка (media/reel-en.mp4, reel-ru.mp4), иначе общий reel.mp4 — он с русским треком,
// поэтому в английской версии подписываем, что текст песни бывает на любом языке
const reelHas = {};
async function setReel(l) {
  const own = `media/reel-${l}.mp4`;
  if (reelHas[l] === undefined) reelHas[l] = !!(await AVAIL).reel?.[l];
  if (l !== lang) return;
  const src = reelHas[l] ? own : "media/reel.mp4";
  $("#reelNote").hidden = reelHas[l] || l === "ru";
  if (!reelV.src.endsWith(src)) {
    reelV.poster = reelHas[l] ? `media/reel-${l}.jpg` : "media/reel.jpg";
    reelV.src = src;
    if (!reelV.dataset.paused) reelV.play().catch(() => {});
  }
}
new IntersectionObserver(([e]) => { if (e.isIntersecting && !reelV.dataset.paused) reelV.play().catch(() => {}); else reelV.pause(); }, { threshold: 0.35 }).observe(reelV);
$("#reelPlay").addEventListener("click", () => {
  if (reelV.paused) { delete reelV.dataset.paused; reelV.play(); $("#reelPlay").textContent = "❚❚"; }
  else { reelV.dataset.paused = "1"; reelV.pause(); $("#reelPlay").textContent = "▶"; }
});
(async () => {
  if (!(await AVAIL).beforeAfter) return;
  const before = $("#baBefore"), after = $("#baAfter"), frame = $("#baFrame"), handle = $("#baHandle");
  before.src = "media/before.mp4"; after.src = "media/after.mp4";
  $("#ba").hidden = false;
  // держим два видео синхронно
  new IntersectionObserver(([e]) => { if (e.isIntersecting) { before.currentTime = after.currentTime; before.play().catch(() => {}); after.play().catch(() => {}); } else { before.pause(); after.pause(); } }, { threshold: 0.3 }).observe(frame);
  setInterval(() => { if (!after.paused && Math.abs(before.currentTime - after.currentTime) > 0.08) before.currentTime = after.currentTime; }, 500);
  const set = (x) => { const k = Math.max(0, Math.min(100, x)); frame.style.setProperty("--x", `${k}%`); handle.setAttribute("aria-valuenow", Math.round(k)); };
  const fromEvent = (e) => { const r = frame.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
  let drag = false;
  frame.addEventListener("pointerdown", (e) => { drag = true; frame.setPointerCapture(e.pointerId); fromEvent(e); });
  frame.addEventListener("pointermove", (e) => { if (drag) fromEvent(e); });
  frame.addEventListener("pointerup", () => { drag = false; });
  handle.addEventListener("keydown", (e) => {
    const v = Number(handle.getAttribute("aria-valuenow"));
    if (e.key === "ArrowLeft") set(v - 5); if (e.key === "ArrowRight") set(v + 5);
  });
})();

// ---------- установка: окно SmartScreen по кругу показывает, куда нажать ----------
{
  const win = $("#ssWin");
  let s = 0, timer = 0;
  const step = () => { s = (s + 1) % 3; win.className = `ss__win${s ? ` s${s}` : ""}`; timer = setTimeout(step, s === 2 ? 3200 : 1600); };
  new IntersectionObserver(([e]) => { clearTimeout(timer); if (e.isIntersecting) timer = setTimeout(step, 900); }).observe(win);
  const cmd = $("#hashCmd");
  cmd.addEventListener("click", () => {
    navigator.clipboard?.writeText(cmd.querySelector("code").textContent).then(() => {
      const sp = cmd.querySelector("span"), was = sp.innerHTML;
      sp.textContent = UI[lang].copied; cmd.classList.add("ok");
      setTimeout(() => { sp.innerHTML = was; cmd.classList.remove("ok"); }, 1600);
    }).catch(() => {});
  });
}

// ---------- 3D-текст песни ----------
let lyr = null, lyrTouched = false, lyrStyle = "accent";
async function playLyrics() {
  if (!lyr) return;
  await document.fonts.load('800 120px "Unbounded"', "AЯ").catch(() => {});
  lyr.play($("#lyrInput").value || UI[lang].lyr, lyrStyle);
}
(async () => {
  try {
    if (!document.createElement("canvas").getContext("webgl2")) throw new Error("no webgl2");
    const { startLyrics } = await import("./lyrics3d.js");
    lyr = startLyrics($("#lyrCanvas"));
    $("#lyrInput").value = UI[lang].lyr;
    playLyrics();
  } catch { $("#lyrics").hidden = true; numberSections(); }
})();
$("#lyrForm").addEventListener("submit", (e) => { e.preventDefault(); lyrTouched = true; playLyrics(); });
$("#lyrInput").addEventListener("input", () => { lyrTouched = true; });
$$("#lyrStyles button").forEach((b) => b.addEventListener("click", () => {
  lyrStyle = b.dataset.s;
  $$("#lyrStyles button").forEach((x) => x.classList.toggle("on", x === b));
  playLyrics();
}));

// ---------- своя демка: разбор в браузере ----------
const TAG_EN = { "сквозь стену": "wallbang", "через смок": "through smoke", "в прыжке": "mid-air", "ослепленным": "while blind", "ножом": "knife", "зевс": "zeus",
  "коллатерал": "collateral", "все в голову": "all headshots", "открытие": "opening", "эко": "eco", "пистолетка": "pistol round", "решающий раунд": "deciding round", "ниндзя-дефьюз": "ninja defuse" };
const tagText = (t) => {
  if (lang === "ru") return t;
  let m;
  if ((m = /^(\d+) м$/.exec(t))) return `${m[1]} m`;
  if ((m = /^за ([\d.]+) с$/.exec(t))) return `in ${m[1]} s`;
  if ((m = /^клатч (1v\d)$/.exec(t))) return `clutch ${m[1]}`;
  return TAG_EN[t] || t;
};
const TIER_NAME = { legend: 4, epic: 3, top: 2, good: 1, ok: 0 };
let demo = null; // { map, moments, players }
(async () => {
  // блок включается, только если рядом лежит WASM-парсер
  if (!(await AVAIL).parser || typeof Worker === "undefined") return;
  $("#try").hidden = false;
  numberSections();
  const dz = $("#dz"), input = $("#dzFile");
  $("#dzIdle").addEventListener("click", () => input.click());
  input.addEventListener("change", () => input.files[0] && analyze(input.files[0]));
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("is-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("is-over"); const f = e.dataTransfer.files[0]; if (f) analyze(f); });
  $("#dzAgain").addEventListener("click", () => { demo = null; showDz("idle"); input.value = ""; });
  $("#dzPlayer").addEventListener("change", () => renderDemo());
})();
function showDz(which) {
  $("#dzIdle").hidden = which !== "idle"; $("#dzBusy").hidden = which !== "busy"; $("#dzRes").hidden = which !== "res";
  $("#dzErr").hidden = true;
}
function busy(stage, k) {
  showDz("busy");
  $("#dzMsg").textContent = UI[lang].demoStages[stage] || stage;
  $("#dzBar").style.width = `${Math.round(k * 100)}%`;
}
async function analyze(file) {
  if (!/\.dem$/i.test(file.name)) return;
  busy("read", 0.02);
  const worker = new Worker("demo-worker.js");
  const buffer = await file.arrayBuffer();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") busy(m.stage, m.k);
    if (m.type === "error") { worker.terminate(); showDz("idle"); const er = $("#dzErr"); er.hidden = false; er.textContent = fmt(UI[lang].demoErr, m.message); }
    if (m.type === "done") {
      worker.terminate();
      busy("score", 0.97);
      const raw = m.raw;
      const moments = buildMoments(raw, 64).sort((a, b) => b.score - a.score);
      // игроки: из составов раундов (имя + сколько моментов), сначала у кого больше баллов
      const names = new Map();
      for (const r of raw.rounds) for (const p of r.players) if (p.name && (p.team === 2 || p.team === 3)) names.set(p.id, p.name);
      for (const d of raw.events) if (d.attacker_steamid && d.attacker_name) names.set(String(d.attacker_steamid), d.attacker_name);
      const sum = new Map();
      for (const mo of moments) sum.set(mo.steamid, (sum.get(mo.steamid) || 0) + mo.score);
      const players = [...names.entries()].map(([id, name]) => ({ id, name, total: sum.get(id) || 0, n: moments.filter((x) => x.steamid === id).length }))
        .sort((a, b) => b.total - a.total);
      const lastRound = Math.max(0, ...raw.rounds.map((r) => r.round || 0));
      demo = { map: raw.header?.map_name || "", file: file.name, moments, players, lastRound };
      const sel = $("#dzPlayer");
      sel.innerHTML = players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.n}</option>`).join("");
      showDz("res");
      renderDemo();
      $("#try").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };
  worker.postMessage({ buffer }, [buffer]);
}
function renderDemo() {
  if (!demo) return;
  const id = $("#dzPlayer").value || demo.players[0]?.id;
  const mine = demo.moments.filter((m) => m.steamid === id);
  const p = demo.players.find((x) => x.id === id);
  $("#dzMap").textContent = `${demo.map} · ${demo.file}`;
  $("#dzTitle").textContent = `${p?.name || "?"} · ${fmt(UI[lang].moments, mine.length)}`;
  // шкала раундов: высота — баллы лучшего момента в раунде
  const byRound = new Map(mine.map((m) => [m.round, m]));
  const top = Math.max(60, ...mine.map((m) => m.score));
  $("#dzTimeline").innerHTML = Array.from({ length: demo.lastRound }, (_, i) => {
    const m = byRound.get(i + 1);
    const t = m ? tierOf(m.score)[1] : "";
    return `<i class="${t ? `t-${t}` : ""}" style="--h:${m ? Math.max(12, (m.score / top) * 100) : 6}%;--i:${i}" title="${UI[lang].round} ${i + 1}${m ? ` · ${Math.round(m.score)}` : ""}"></i>`;
  }).join("");
  const list = $("#dzList");
  if (!mine.length) { list.innerHTML = `<li class="dz__empty">${UI[lang].noMoments}</li>`; return; }
  const TC = { legend: "var(--legend)", epic: "var(--epic)", top: "var(--top)", good: "var(--good)", ok: "var(--dim)" };
  list.innerHTML = mine.slice(0, 12).map((m, i) => {
    const [, t] = tierOf(m.score);
    const lead = m.tags[0] && /^(ACE|\dK)$/.test(m.tags[0]) ? m.tags[0] : m.clutch ? `1v${m.clutch}` : "1K";
    const rest = m.tags.filter((x) => x !== lead).map(tagText).join(" · ");
    return `<li style="--c:${TC[t]};--i:${i}"><span class="r">R${m.round}</span><span class="k">${esc(lead)}</span><span class="s">${Math.round(m.score)}</span>
      <span class="tags">${esc(rest)}</span><span class="tier mono" style="color:${TC[t]}">${UI[lang].tiers[TIER_NAME[t]]}</span></li>`;
  }).join("");
}

// ---------- сообщество и аналитика (config.js) ----------
{
  const L = [["discord", "Discord", "#5865f2"], ["telegram", "Telegram", "#2aabee"], ["youtube", "YouTube", "#ff0033"]].filter(([k]) => CONFIG[k]);
  if (L.length) {
    $("#community").hidden = false;
    $("#commLinks").innerHTML = L.map(([k, n, c]) => `<a href="${esc(CONFIG[k])}" target="_blank" rel="noopener" style="--c:${c}"><i></i>${n}</a>`).join("");
    $("#footLinks").innerHTML = L.map(([k, n]) => `<a href="${esc(CONFIG[k])}" target="_blank" rel="noopener">${n}</a>`).join("");
  }
  if (CONFIG.goatcounter) {
    const s = document.createElement("script");
    s.async = true; s.src = "https://gc.zgo.at/count.js";
    s.dataset.goatcounter = `https://${CONFIG.goatcounter}.goatcounter.com/count`;
    document.head.appendChild(s);
    // клики «Скачать» — отдельным событием, чтобы видеть конверсию
    $$(".js-dl").forEach((a) => a.addEventListener("click", () => window.goatcounter?.count?.({ path: "download", title: "download", event: true })));
  }
}
numberSections();
fetch(`https://api.github.com/repos/${REPO}`)
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((r) => { $("#stars").textContent = `★ ${r.stargazers_count}`; })
  .catch(() => {});

applyLang(lang);
