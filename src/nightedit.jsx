// Вкладка «Эдит»: пресеты эдитов из нескольких демок. Пока один — Night Edit (как ночные TikTok-эдиты):
// интро ночью — звёздное небо с луной, сиреневый текст песни с сердцем, светящаяся пыль, рамка на цели,
// светящееся оружие; дальше дневной монтаж лучших киллов, каждый ровно на удар трека.
import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tr, useLang } from "./i18n";
import { drawLyricStyle, wordsOf, heartWord, lyricFont } from "./lyricStyles";
import { drawDust, drawTargets, buildSkyPano, drawSky } from "./nightfx";
import { editKills, commonPlayer, flickOf, scoreKill, groupKills, clipOf, partInfo, planRhythm, pickDiverse } from "./montage";
import { mapName } from "./dossier";
import { useTrackPlayer, parseLrc, renderLyricFrames } from "./music";
import { alignWordTimes } from "./lyricsAlign";
import previewBg from "./assets/previews/lyrics-bg.webp";

const SNIPER_OR_KNIFE = /awp|ssg08|knife|bayonet/;
const WEAPON = (w) => ({ ssg08: "SSG 08", awp: "AWP", ak47: "AK-47", m4a1_silencer: "M4A1-S", m4a1: "M4A4", deagle: "Deagle", usp_silencer: "USP-S", glock: "Glock" }[w] || w.replace(/_/g, " ").toUpperCase());
const MAX_PICK = 40;

// Живое превью пресета: ночная карта, кусок звёздного неба, пыль, текст с сердцем и рамка на цели
function NightPreview() {
  const ref = useRef(null);
  const lang = useLang();
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, k = H / 1080 * 1.5;
    const img = new Image();
    img.src = previewBg;
    const hf = 2 * Math.atan(Math.tan(Math.PI / 4) * (16 / 9) / (4 / 3));
    const proj = { cx: W / 2, cy: H / 2, f: W / 2 / Math.tan(hf / 2) };
    const pano = buildSkyPano((proj.f * Math.PI) / 180, 8);
    const sky = document.createElement("canvas");
    sky.width = W; sky.height = H;
    const sctx = sky.getContext("2d");
    const p = { text: tr("если я найду тебя"), t0: 0.4, t1: 1.9, end: 4.1 };
    p.heart = heartWord(p.text);
    [lyricFont("night", 40), '700 40px "Nunito"'].forEach((f) => document.fonts.load(f, "Aa Яя").catch(() => {}));
    const eye = [[0, 0, 0, 64], [99999, 0, 0, 64]];
    const start = performance.now();
    let raf;
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (cv.checkVisibility && !cv.checkVisibility({ visibilityProperty: true })) return;
      const t = ((now - start) / 1000) % 4.6;
      // камера медленно ведёт вправо — небо и пыль плывут
      const view = { yaw: 6 - t * 2.2, pitch: -2 };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      if (img.complete && img.naturalWidth) {
        ctx.filter = "brightness(0.52) saturate(0.5) contrast(1.1)";
        ctx.drawImage(img, 0, 0, W, H);
        ctx.filter = "none";
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = "#5b55d8";
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = "rgba(60,20,90,.35)";
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "source-over";
      } else { ctx.fillStyle = "#0b0f24"; ctx.fillRect(0, 0, W, H); }
      // небо сверху, мягко уходит в карту
      drawSky(sctx, pano, view, W, H);
      sctx.globalCompositeOperation = "destination-in";
      const g = sctx.createLinearGradient(0, 0, 0, H * 0.42);
      g.addColorStop(0, "#000"); g.addColorStop(0.75, "rgba(0,0,0,.85)"); g.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = g; sctx.fillRect(0, 0, W, H);
      sctx.globalCompositeOperation = "source-over";
      ctx.drawImage(sky, 0, 0);
      drawDust(ctx, { t, view, proj, k });
      // рамка на цели: «килл» на 3.2 с
      const tick = t * 64;
      drawTargets(ctx, { tick, eye, view, proj, k, targets: [{ kill: 3.2 * 64, pts: [[0, 620, -150 - t * 20, -20], [400, 620, -150 - t * 20, -20]] }] });
      if (t >= p.t0 && t < p.end) {
        const sc = Math.max(0, Math.min(1, (t - (p.end - 0.6)) / 0.6));
        ctx.setTransform(1, 0, 0, 1, W * 0.42, H * 0.34);
        drawLyricStyle(ctx, "night", { p, t, size: 40 * k * 0.62, k, pi: 5, sc, words: wordsOf(p), maxW: W * 0.8 });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lang]);
  return <canvas ref={ref} width={960} height={540} className="ne-canvas" />;
}

const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const fmtLeft = (s) => (s >= 90 ? tr("~{0} мин", Math.round(s / 60)) : s >= 45 ? tr("~1 мин") : tr("~{0} с", Math.max(5, Math.round(s / 5) * 5)));

// Ход сборки эдита: общий процент, сколько примерно осталось и что сейчас происходит.
// Каждая демка — одна часть работы (её progress 0..100 приходит из рендера), склейка — ещё треть части.
// Оставшееся время — по фактической скорости с начала сборки, сглаженное, чтобы цифра не прыгала.
// Прослушать трек прямо во вкладке: play идёт с выбранного начала, ползунок двигает начало и
// перематывает, сверху бежит позиция, под ним — строка, которая сейчас поётся
function TrackPreview({ music, setMusic }) {
  const player = useTrackPlayer(music.path);
  useEffect(() => () => player.pause(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const lines = useMemo(() => (music.lrc ? parseLrc(music.lrc).filter((l) => l.text) : []), [music.lrc]);
  const sung = player.playing ? lines.filter((l) => l.t <= player.pos).pop()?.text : null;
  return (
    <>
      <div className="ne-player-row">
        <button type="button" className={`mu-play ${player.playing ? "is-on" : ""}`} disabled={player.loading}
          onClick={() => (player.playing ? player.pause() : player.play(music.start || 0))} aria-label={player.playing ? tr("Пауза") : tr("Играть")}>
          {player.loading ? <i className="mu-spin" /> : player.playing ? <i className="mu-ico-stop" /> : <i className="mu-ico-play" />}
        </button>
        <div className="ne-seek">
          <input type="range" className="mu-range" min={0} max={Math.max(0, music.duration - 5)} step={0.5} value={music.start || 0}
            onChange={(e) => { const v = +e.target.value; setMusic((m) => ({ ...m, start: v, autoStart: false })); if (player.playing) player.seek(v); }}
            aria-label={tr("Начало трека в эдите")} />
          {player.playing && <span className="ne-seek__head" style={{ left: `${(player.pos / music.duration) * 100}%` }} />}
        </div>
        <b className="mono accent">{fmtT(player.playing ? player.pos : music.start || 0)}</b>
      </div>
      {sung && <span className="ne-sung">{sung}</span>}
    </>
  );
}

const CUT_W = 0.35;
function EditProgress({ job, progress, stage }) {
  const [now, setNow] = useState(Date.now());
  const eta = useRef(null);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const cur = job.phase === "cut" ? 1 : job.phase === "rec" ? Math.min(1, (progress || 0) / 100) : 0;
  const done = job.done + (job.phase === "cut" ? 0 : cur);
  const f = Math.min(1, (done + (job.phase === "cut" ? job.cut.frac * CUT_W : 0)) / (job.total + CUT_W));
  const elapsed = (now - job.startedAt) / 1000;
  if (f > 0.04) {
    const raw = (elapsed * (1 - f)) / f;
    eta.current = eta.current == null ? raw : eta.current * 0.8 + raw * 0.2;
  }
  const estMb = job.phase === "cut" && job.cut.frac > 0.05 ? job.cut.mb / job.cut.frac : null;
  const steps = [
    ...Array.from({ length: job.total }, (_, i) => ({
      label: tr("запись · {0}", job.maps[i] || "demo"),
      state: i < job.done ? "done" : i === job.done && job.phase !== "cut" ? "now" : job.phase === "cut" ? "done" : "wait",
    })),
    { label: tr("склейка под бит"), state: job.phase === "cut" ? "now" : "wait" },
  ];
  return (
    <div className="ne-prog">
      <div className="ne-prog__top">
        <b className="ne-prog__pct mono">{Math.floor(f * 100)}<small>%</small></b>
        <div className="ne-prog__info">
          <span className="ne-prog__left">{eta.current != null && f < 0.995 ? tr("осталось {0}", fmtLeft(eta.current)) : tr("считаю, сколько осталось...")}</span>
          <span className="mono dim">{tr("идет {0}", fmtT(elapsed))}{estMb ? ` · ${tr("файл {0} из ~{1} МБ", Math.round(job.cut.mb), Math.round(estMb))}` : ""}</span>
        </div>
      </div>
      <div className="ne-prog__bar"><i style={{ width: `${f * 100}%` }} /></div>
      <span className="ne-prog__stage accent">{stage || job.label}</span>
      <ol className="ne-prog__steps">
        {steps.map((st, i) => <li key={i} className={`is-${st.state}`}><i />{st.label}</li>)}
      </ol>
    </div>
  );
}

export function NightEdit({ Frame, Hint, archive, cs2, hlae, out, music, setMusic, video, playerId, rendering, progress, stage, renderPart, onDone, onGoSound }) {
  const [replays, setReplays] = useState([]);
  const [chosen, setChosen] = useState(() => new Set());
  const [scan, setScan] = useState(null); // { me, groups: [...] }
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [intro, setIntro] = useState(null);
  // текст: «Акцент» — по слову на удар поверх всего эдита (как в TikTok-эдитах), «Night» — в мире,
  // только в интро, с сердцем. Ночь (звёздное небо, светящееся оружие, пыль): в интро, везде или нигде.
  const [textStyle, setTextStyle] = useState(() => { try { return localStorage.getItem("cf-edit-text") || "accent"; } catch { return "accent"; } });
  const [nightScope, setNightScope] = useState(() => { try { return localStorage.getItem("cf-edit-night") || "intro"; } catch { return "intro"; } });
  useEffect(() => { try { localStorage.setItem("cf-edit-text", textStyle); localStorage.setItem("cf-edit-night", nightScope); } catch {} }, [textStyle, nightScope]);
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null); // ход сборки (EditProgress)
  const cancel = useRef(false);
  // разобранные демки (чтобы смена игрока не разбирала их заново) и игроки, которые есть во всех
  const parsed = useRef(null); // { paths, raws }
  const wordsCache = useRef(new Map()); // путь трека -> слова со временем (Whisper)
  const [players, setPlayers] = useState([]); // [{ id, name, kills }]
  // уже записанные демки этой сборки: если запись упала (например, вылетела CS2), повторное
  // «Собрать эдит» с теми же моментами продолжает с упавшей демки, а не пишет всё заново
  const doneRef = useRef(null); // { sig, stamp, demos: Map(demoPath -> dir) }

  useEffect(() => { if (cs2) invoke("list_replays", { cs2 }).then(setReplays).catch(() => {}); }, [cs2]);

  // все известные демки: скачанные матчи CS2 и архив, без повторов
  const demos = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const r of replays) if (!seen.has(r.path)) { seen.add(r.path); list.push({ path: r.path, map: r.map, when: r.modified, src: "CS2" }); }
    for (const a of archive) if (!seen.has(a.path)) { seen.add(a.path); list.push({ path: a.path, map: a.info?.map || "", when: a.openedAt || a.addedAt, src: a.title || a.file }); }
    return list.sort((a, b) => (b.when || 0) - (a.when || 0));
  }, [replays, archive]);

  const toggleDemo = (p) => setChosen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const addFile = async () => {
    const f = await openDialog({ multiple: true, filters: [{ name: "CS2 demo", extensions: ["dem"] }] }).catch(() => null);
    const list = Array.isArray(f) ? f : f ? [f] : [];
    if (list.length) setChosen((s) => new Set([...s, ...list]));
  };

  // только хедшоты и сколько моментов брать автоматически (как в TikTok-эдитах: много киллов подряд)
  const [hsOnly, setHsOnly] = useState(() => { try { return localStorage.getItem("cf-edit-hs") !== "0"; } catch { return true; } });
  const [pickN, setPickN] = useState(() => { try { return Number(localStorage.getItem("cf-edit-n")) || 24; } catch { return 24; } });
  useEffect(() => { try { localStorage.setItem("cf-edit-hs", hsOnly ? "1" : "0"); localStorage.setItem("cf-edit-n", String(pickN)); } catch {} }, [hsOnly, pickN]);
  const autoPick = (groups, n) => {
    const top = pickDiverse(groups, n);
    setPicked(new Set(top.map((g) => g.id)));
    setIntro((top.find((g) => g.special) || top[0])?.id ?? null);
  };

  const musicReady = music.enabled && music.path;
  const lyricsReady = musicReady && music.showLyrics && music.lrc;

  // моменты игрока me: его киллы во всех демках, флик по углам камеры, оценка
  const scoreFor = async (me, hs = hsOnly, n = pickN) => {
    const { paths, raws } = parsed.current;
    const groups = [];
    for (let i = 0; i < paths.length; i++) {
      setBusy(tr("ищу флики: демка {0}/{1}...", i + 1, paths.length));
      const raw = raws[i];
      // только хедшоты: в клип попадают лишь убийства в голову (мультикилл — из одних хедшотов)
      const kills = editKills(raw, me).filter((k) => !hs || k.hs);
      if (!kills.length) continue;
      const cams = JSON.parse(await invoke("parse_cam", { path: paths[i], steamid: me, ranges: JSON.stringify(kills.map((k) => [k.tick - 14, k.tick])) }));
      kills.forEach((k, j) => { k.flick = flickOf(cams[j], k.tick); });
      const player = (raw.players || []).find((p) => String(p.steamid) === me);
      const roster = (raw.players || []).map((p) => ({ id: String(p.steamid), name: p.name, team: p.team_number, slot: p.slot }));
      const map = demos.find((d) => d.path === paths[i])?.map || "";
      for (const g of groupKills(kills)) {
        g.kills.forEach((k) => Object.assign(k, scoreKill(k)));
        const score = g.kills.reduce((s, k) => s + k.score, 0);
        const tags = [...new Set(g.kills.flatMap((k) => k.tags))];
        groups.push({
          id: `${i}:${g.round}:${g.kills[0].tick}`, demo: paths[i], di: i, map, round: g.round, kills: g.kills, score, tags,
          weapon: g.kills.at(-1).weapon, flick: Math.max(...g.kills.map((k) => k.flick || 0)),
          special: g.kills.some((k) => SNIPER_OR_KNIFE.test(k.weapon)), name: player?.name || "", slot: player?.slot ?? 1, roster,
        });
      }
    }
    groups.sort((a, b) => b.score - a.score);
    setScan({ me, groups });
    autoPick(groups, n);
  };
  const setHs = async (v) => {
    setHsOnly(v);
    if (!parsed.current || !scan) return;
    setErr("");
    try { await scoreFor(scan.me, v); } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  };
  const setN = (n) => { setPickN(n); if (scan) autoPick(scan.groups, n); };

  // поиск моментов: разбор каждой демки и игроки, которые есть во всех выбранных демках
  // (в пати с другом таких несколько — тогда сверху выбор, чей эдит)
  const findMoments = async () => {
    setErr(""); setBusy(tr("разбираю демки...")); setScan(null); setResult(null); setPlayers([]);
    try {
      const paths = [...chosen];
      const raws = [];
      for (let i = 0; i < paths.length; i++) {
        setBusy(tr("разбираю демку {0}/{1}...", i + 1, paths.length));
        raws.push(JSON.parse(await invoke("parse_demo", { path: paths[i] })));
      }
      parsed.current = { paths, raws };
      const ids = raws.map((r) => new Set((r.players || []).map((p) => String(p.steamid))));
      const common = [...ids[0]].filter((id) => ids.every((set) => set.has(id)));
      if (!common.length) throw new Error(tr("Не нашел игрока, который есть во всех выбранных демках. Выбери демки одного аккаунта."));
      const list = common.map((id) => ({
        id,
        name: (raws.flatMap((r) => r.players || []).find((p) => String(p.steamid) === id) || {}).name || id,
        kills: raws.reduce((n, r) => n + editKills(r, id).length, 0),
      })).sort((a, b) => b.kills - a.kills);
      setPlayers(list);
      // кто ты: игрок, которого ты выбирал тут в прошлый раз → твой аккаунт Steam на этом компе →
      // игрок с вкладки «Демо» → и только потом тот, у кого больше киллов (в пати это может быть друг)
      const has = (id) => id && list.some((p) => p.id === String(id));
      let saved = null;
      try { saved = localStorage.getItem("cf-edit-me"); } catch {}
      const local = await invoke("steam_users").catch(() => []);
      const me = [saved, ...local, commonPlayer(raws, playerId) && playerId].find(has) ?? list[0].id;
      await scoreFor(String(me));
    } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  };
  const pickPlayer = async (id) => {
    if (!parsed.current || id === scan?.me) return;
    try { localStorage.setItem("cf-edit-me", id); } catch {}
    setErr("");
    try { await scoreFor(id); } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  };

  const togglePick = (id) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else if (n.size < MAX_PICK) n.add(id);
    return n;
  });

  const sel = scan ? scan.groups.filter((g) => picked.has(g.id)) : [];
  const introG = sel.find((g) => g.id === intro) || sel[0];
  // примерная длина: интро ~8 с + по ~1.4 с на килл
  const estSec = sel.length ? Math.round(10 + sel.filter((g) => g !== introG).reduce((s, g) => s + 0.5 + g.kills.length * 0.5, 0)) : 0;
  const demoCount = new Set(sel.map((g) => g.demo)).size;
  // хватит ли трека: от выбранного начала до конца должно влезть всё
  const trackLeft = music.duration ? Math.max(0, music.duration - (music.start || 0)) : null;
  const shortTrack = trackLeft != null && estSec > 0 && estSec > trackLeft;
  const canBuild = sel.length >= 2 && musicReady && !rendering && !busy && hlae && cs2 && out;

  const sig = sel.map((g) => g.id).join("|") + "#" + (introG?.id || "") + "#" + nightScope + "#" + textStyle;
  const resumable = doneRef.current?.sig === sig && doneRef.current.demos.size > 0;

  // CS2 после рендера закрывается не мгновенно: следующий запуск сразу вслед падал при загрузке демки
  const waitGameClosed = async () => {
    for (let i = 0; i < 60 && await invoke("cs2_running").catch(() => false); i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 5000));
  };

  const build = async () => {
    setErr(""); setResult(null); cancel.current = false;
    if (!resumable) doneRef.current = { sig, stamp: new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-"), demos: new Map() };
    const { stamp, demos: doneDemos } = doneRef.current;
    try {
      const base = await join(out, ".clipforge_edit", stamp);
      const parts = []; // { g, path, info }
      const byDemo = new Map();
      for (const g of sel) { if (!byDemo.has(g.demo)) byDemo.set(g.demo, []); byDemo.get(g.demo).push(g); }
      // запись — один шаг (все демки за один запуск игры), потом склейка
      const maps = [[...byDemo.values()].map((gs) => mapName(gs[0].map) || "demo").join(" → ")];
      setJob({ startedAt: Date.now(), total: 1, done: 0, phase: "rec", maps, cut: { frac: 0, mb: 0 }, label: "" });
      // клипы одной демки — по порядку в демке: игра проигрывает её вперёд
      const plans = [...byDemo].map(([demoPath, gs]) => {
        gs.sort((a, b) => a.kills[0].tick - b.kills[0].tick);
        const clips = gs.map((g) => ({ ...clipOf(g, {
          steamid: scan.me, name: g.name, slot: g.slot, intro: g === introG,
          night: nightScope === "all" || (nightScope === "intro" && g === introG),
        }), demo: demoPath }));
        return { demoPath, gs, clips };
      });
      // все ещё не записанные демки — за один запуск CS2: F10 жмётся один раз в первой демке,
      // дальше игра сама открывает следующую и пишет её клипы (render.rs, cf_<i>_load)
      const todo = plans.filter((p) => !doneDemos.has(p.demoPath));
      if (todo.length) {
        if (resumable) { setBusy(tr("жду, пока CS2 закроется...")); await waitGameClosed(); }
        setBusy(todo.length > 1
          ? tr("запись {0} демок за один запуск: в игре нажми F10, когда загрузится первая, дальше все само", todo.length)
          : tr("запись демки: в игре нажми F10, когда демка загрузится"));
        const dir = await join(base, `r${doneDemos.size}`);
        await renderPart({ demoPath: todo[0].demoPath, steamid: scan.me, roster: todo[0].gs[0].roster,
          clips: todo.flatMap((p) => p.clips), partsDir: dir, partLyrics: textStyle === "night" });
        // куски нумеруются подряд по всему заданию: part_00… сначала первой демки, потом следующей
        let first = 0;
        for (const p of todo) { doneDemos.set(p.demoPath, { dir, first }); first += p.clips.length; }
      }
      for (const p of plans) {
        const { dir, first } = doneDemos.get(p.demoPath);
        for (let i = 0; i < p.gs.length; i++) {
          parts.push({ g: p.gs[i], path: await join(dir, `part_${String(first + i).padStart(2, "0")}.mp4`), info: partInfo(p.clips[i]) });
        }
      }
      setBusy(tr("собираю эдит под бит..."));
      setJob((j) => ({ ...j, done: j.total, phase: "cut" }));
      const unCut = await listen("montage-progress", (e) => setJob((j) => j && ({ ...j, cut: e.payload })));
      // порядок: интро, потом по нарастающей — самые крутые киллы в конце
      const intro0 = parts.find((p) => p.g === introG);
      const rest = parts.filter((p) => p !== intro0).sort((a, b) => a.g.score - b.g.score);
      const order = [intro0, ...rest].filter(Boolean).map((p) => ({ path: p.path, dur: p.info.dur, kills: p.info.kills, intro: p === intro0, score: p.g.score }));
      // Дроп — на начало припева (как в TikTok-эдитах: киллы подряд идут на самой громкой части).
      // Припев — первая повторяющаяся строка после начала трека. Если до него слишком далеко или
      // близко для интро, начало трека в эдите сдвигается так, чтобы интро закончилось на припеве.
      // (Для текста Night в интро начало не трогаем: текст там уже записан в кусок.)
      let start = music.start || 0, dropAt = null;
      if (textStyle === "accent" && music.lrc && intro0) {
        const ls = parseLrc(music.lrc).filter((l) => l.text);
        const key = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
        const cnt = new Map();
        ls.forEach((l) => cnt.set(key(l.text), (cnt.get(key(l.text)) || 0) + 1));
        const chorus = ls.find((l) => l.t >= start + 3 && (cnt.get(key(l.text)) || 0) >= 2 && key(l.text).length > 3);
        if (chorus) {
          const introLen = intro0.info.dur + 0.5;
          if (chorus.t - start > introLen + 1.5 || chorus.t - start < 4) start = Math.max(0, chorus.t - introLen);
          dropAt = chorus.t - start;
        }
      }
      const beats = await invoke("track_beats", { hlae, path: music.path, offset: start, dur: 240 }).catch(() => []);
      const plan = planRhythm(order, beats, { dropAt });
      // «Акцент» — по слову на удар поверх всего эдита: кадры текста на итоговой шкале эдита
      // (30 к/с хватает для текста), слова встают на удары трека
      let lyrics = null;
      if (textStyle === "accent" && lyricsReady) {
        setBusy(tr("текст поверх эдита..."));
        const dir = await join(base, "lyrics");
        const save = (name, bytes) => invoke("save_file", bytes, { headers: { "x-path": encodeURIComponent(`${dir}\\${name}`) } });
        // время каждого слова по звуку (Whisper + сопоставление с текстом): слово выходит, когда его поют
        let wordTimes = null;
        try {
          setBusy(tr("ставлю каждое слово на свое место в треке..."));
          let words = wordsCache.current.get(music.path);
          if (!words) {
            const lang = /[а-яё]/i.test(music.lrc) ? "ru" : "auto";
            words = await invoke("track_words", { hlae, path: music.path, lang });
            wordsCache.current.set(music.path, words);
          }
          const all = parseLrc(music.lrc);
          const idx = all.map((l, i) => (l.text ? i : -1)).filter((i) => i >= 0);
          const wt = alignWordTimes(idx.map((i) => all[i].text), words.map(([t, w]) => ({ t, w })));
          // слово далеко от своей строки (ошибка сопоставления) — не берём, остаётся время по строке
          wordTimes = new Map(idx.map((li, n) => {
            const next = all.slice(li + 1).find((l) => l.text)?.t ?? all[li].t + 8;
            return [li, wt[n].map((t) => (t != null && t >= all[li].t - 0.6 && t <= next + 0.3 ? t : null))];
          }));
        } catch { wordTimes = null; }
        setBusy(tr("текст поверх эдита..."));
        const list = await renderLyricFrames({
          lrc: music.lrc, start, clip: { start: 0, end: Math.ceil(plan.total * 64), killTicks: [] }, cam: [],
          slowmo: false, fps: 30, W: video.width, H: video.height, save, style: "accent", smart: false,
          beats: beats.map((b) => start + b), wordTimes,
        });
        await save("lyrics.ffconcat", new TextEncoder().encode(list));
        lyrics = { list: `${dir}\\lyrics.ffconcat`, mul: `${dir}\\lyrics_mul.ffconcat` };
        setBusy(tr("собираю эдит под бит..."));
      }
      const file = await join(out, `${stamp.replace("_", " ")} night edit.mp4`);
      await invoke("build_montage", { m: {
        hlae, out: file, fps: video.fps, width: video.width, height: video.height, crf: video.crf, gpuEncoder: video.gpu,
        segments: plan.segments, whips: plan.whips, punches: plan.punches, flashes: plan.flashes,
        music: { path: music.path, start, musicVol: music.musicVol, gameVol: Math.min(music.gameVol, 0.55) },
        lyrics: lyrics?.list ?? null, lyricsMul: lyrics?.mul ?? null,
      } }).finally(unCut);
      setResult({ file, total: plan.total, kills: plan.punches.length });
      doneRef.current = null;
      onDone?.(file);
    } catch (e) {
      const left = byDemoCount() - (doneRef.current?.demos.size || 0);
      setErr(String(e.message || e) + (doneRef.current?.demos.size ? " · " + tr("записанные демки сохранены: нажми «Продолжить сборку», осталось {0}", left) : ""));
    }
    setBusy("");
    setJob(null);
  };
  const byDemoCount = () => new Set(sel.map((g) => g.demo)).size;

  return (
    <>
      <Frame title={tr("Пресеты эдитов")} meta={tr("1 пресет")} className="span-2 ne"
        help={tr("Пресет сразу включает все, что нужно для эдита в определенном стиле: текст, эффекты, цвет, монтаж под бит. Моменты берутся из нескольких демок сразу.")}>
        <div className="ne-hero">
          <div className="ne-preview">
            <NightPreview />
            <span className="ne-badge mono">PRESET 01</span>
          </div>
          <div className="ne-about">
            <h3 className="ne-title">Night Edit</h3>
            <p className="dim">{tr("Как ночные эдиты из TikTok. Интро ночью: звездное небо с луной, сиреневый текст песни с сердцем, светящаяся пыль, рамка на цели и светящееся оружие. Дальше быстрый дневной монтаж лучших киллов, каждый ровно на удар трека.")}</p>
            <ul className="ne-feats">
              {[
                ["✦", tr("текст Night: буквы выпрыгивают, сердце вокруг слова")],
                ["☾", tr("звездное небо и ночной цвет в интро")],
                ["◇", tr("рамка со световым лучом на цели перед киллом")],
                ["⚡", tr("светящееся оружие в руках")],
                ["♫", tr("киллы ровно на удары, рывки на склейках")],
              ].map(([i, t]) => <li key={t}><i>{i}</i>{t}</li>)}
            </ul>
          </div>
        </div>
      </Frame>

      <Frame title={tr("1 · Демки")} meta={tr("выбрано {0}", chosen.size)} className="ne-step">
        <div className="ne-demos">
          {demos.length === 0 && <p className="empty dim">{tr("Пока нет демок. Скачай матч в CS2 или добавь .dem файл.")}</p>}
          {demos.slice(0, 30).map((d) => (
            <button key={d.path} type="button" className={`ne-demo ${chosen.has(d.path) ? "is-on" : ""}`} onClick={() => toggleDemo(d.path)}>
              <i className="check" />
              <b>{mapName(d.map) || d.path.split(/[\\/]/).pop()}</b>
              <span className="mono dim">{d.src === "CS2" ? tr("матч CS2") : d.src}</span>
            </button>
          ))}
        </div>
        <button type="button" className="chip" onClick={addFile}>{tr("+ добавить .dem")}</button>
      </Frame>

      <Frame title={tr("2 · Трек")} meta={musicReady ? tr("готов") : tr("не выбран")} className="ne-step">
        {musicReady ? (
          <div className="ne-track">
            <b>{music.path.split(/[\\/]/).pop()}</b>
            <span className="mono dim">{lyricsReady
              ? (textStyle === "accent" ? tr("с текстом · по слову на удар, киллы с припева") : tr("с текстом · стиль Night в интро"))
              : tr("без текста: в интро будет только музыка")}</span>
            {music.duration > 0 && (
              <>
                {/* с какого места трека начнется эдит (интро с текстом идет с этого же места);
                    key — новый трек, новый плеер (плеер запоминает файл при первом запуске) */}
                <TrackPreview key={music.path} music={music} setMusic={setMusic} />
                <span className="mono dim">
                  {tr("трек с {0} · до конца {1}", fmtT(music.start || 0), fmtT(trackLeft ?? 0))}
                  {estSec > 0 && <> · {tr("эдит ~{0} с", estSec)}</>}
                </span>
                {shortTrack && <span className="mono err">{tr("Трека не хватит: эдит ~{0} с, а до конца трека {1} с. Сдвинь начало раньше или убери пару моментов.", estSec, Math.floor(trackLeft))}</span>}
              </>
            )}
          </div>
        ) : (
          <p className="empty dim">{tr("Эдит собирается под трек: выбери песню (и текст) во вкладке «Звук».")}</p>
        )}
        <button type="button" className="chip" onClick={onGoSound}>{tr("открыть «Звук»")}</button>
        <button type="button" className="go go--ghost ne-find" disabled={!chosen.size || !!busy || rendering} onClick={findMoments}>
          {tr("Найти лучшие моменты")}
        </button>
      </Frame>

      {scan && (
        <Frame title={tr("3 · Моменты")} meta={tr("выбрано {0} из {1}", picked.size, scan.groups.length)} className="span-2 ne-step"
          help={tr("Оценка для эдита: хедшоты, AWP и SSG, резкий флик прицела перед выстрелом, ноускоупы, прыжки, ножи, мультикиллы. Звезда - клип для ночного интро с текстом.")}>
          {players.length > 0 && (
            <div className="ne-player">
              <span className="ne-player__who">
                {tr("Эдит игрока")} <b>{players.find((p) => p.id === scan.me)?.name}</b>
              </span>
              {players.length > 1 && (
                <>
                  <span className="mono dim">{tr("в этих демках есть еще - нажми, чтобы взять его моменты:")}</span>
                  {players.filter((p) => p.id !== scan.me).map((p) => (
                    <button key={p.id} type="button" className="chip" disabled={!!busy} onClick={() => pickPlayer(p.id)}>
                      {p.name} <b className="mono">{tr("{0} килл.", p.kills)}</b>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          <div className="ne-pickbar">
            <button type="button" className={`chip ${hsOnly ? "is-on" : ""}`} disabled={!!busy} onClick={() => setHs(!hsOnly)}>
              {tr("только хедшоты")}
            </button>
            <span className="mono dim">{tr("взять лучших (разное оружие):")}</span>
            <div className="ratios">
              {[16, 24, 32].map((n) => (
                <button key={n} type="button" className={pickN === n ? "is-on" : ""} onClick={() => setN(n)}>{n}</button>
              ))}
            </div>
            <span className="mono dim">{tr("стволов: {0}", new Set(sel.map((g) => g.weapon)).size)}</span>
          </div>
          <div className="ne-kills">
            {scan.groups.slice(0, 80).map((g, i) => {
              const on = picked.has(g.id);
              const top = scan.groups[0].score;
              return (
                <div key={g.id} className={`ne-kill ${on ? "is-on" : ""} ${intro === g.id ? "is-intro" : ""}`} style={{ "--i": i }}>
                  <button type="button" className="ne-kill__main" onClick={() => togglePick(g.id)}>
                    <span className="ne-kill__w">{WEAPON(g.weapon)}</span>
                    <span className="ne-kill__n mono">{g.kills.length > 1 ? `${g.kills.length}K` : "1K"}</span>
                    <span className="ne-kill__tags">{g.tags.slice(0, 4).map((t) => <em key={t}>{tr(t)}</em>)}</span>
                    <span className="ne-kill__meta mono dim">{mapName(g.map) || "demo"} · R{g.round}{g.flick >= 250 ? ` · ${g.flick}°/s` : ""}</span>
                    <span className="ne-kill__bar"><i style={{ width: `${Math.round((g.score / top) * 100)}%` }} /></span>
                    <b className="ne-kill__score mono">{g.score}</b>
                  </button>
                  <button type="button" className="ne-kill__star" title={tr("Сделать интро")} aria-pressed={intro === g.id}
                    onClick={() => { setIntro(g.id); setPicked((s) => new Set([...s, g.id])); }}>★</button>
                </div>
              );
            })}
          </div>
        </Frame>
      )}

      {scan && (
        <Frame title={tr("4 · Сборка")} meta={sel.length ? tr("~{0} с · {1} демк.", estSec, demoCount) : ""} className="span-2 ne-step ne-build">
          <div className="ne-opts">
            <div className="ne-opt">
              <span className="mono dim">{tr("текст")}</span>
              <div className="ratios">
                {[["accent", tr("по слову на удар (как в TikTok)")], ["night", tr("Night с сердцем, в интро")]].map(([k, l]) => (
                  <button key={k} type="button" className={textStyle === k ? "is-on" : ""} onClick={() => setTextStyle(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="ne-opt">
              <span className="mono dim">{tr("ночь (небо, светящееся оружие, пыль)")}</span>
              <div className="ratios">
                {[["intro", tr("только интро")], ["all", tr("весь эдит")], ["none", tr("без ночи")]].map(([k, l]) => (
                  <button key={k} type="button" className={nightScope === k ? "is-on" : ""} onClick={() => setNightScope(k)}>{l}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="ne-build__row">
            <div className="ne-build__sum">
              <b>{tr("{0} моментов", sel.length)}</b>
              <span className="dim">{tr("интро: {0}", introG ? `${WEAPON(introG.weapon)} · ${mapName(introG.map) || "demo"} R${introG.round}` : "-")}</span>
              <span className="dim">{tr("Каждая демка пишется отдельно: когда она загрузится в игре, нажми F10.")}</span>
            </div>
            <button type="button" className="go ne-go" disabled={!canBuild} onClick={build}>{resumable ? tr("Продолжить сборку") : tr("Собрать эдит")}</button>
          </div>
          {job ? <EditProgress job={{ ...job, label: busy }} progress={progress} stage={rendering ? stage : ""} /> : (busy || rendering) && (
            <div className="ne-progress">
              <span className="accent pulse">{stage || busy}</span>
              {rendering && <div className="meter is-running"><div className="meter__track"><div className="meter__fill" style={{ width: `${progress}%` }} /></div></div>}
            </div>
          )}
          {result && (
            <div className="ne-done">
              <b>{tr("Эдит готов")}</b>
              <span className="mono dim">{tr("{0} с · {1} киллов на бит", result.total.toFixed(1), result.kills)}</span>
              <button type="button" className="chip is-on" onClick={() => onDone?.(result.file, true)}>{tr("Смотреть")}</button>
            </div>
          )}
        </Frame>
      )}
      {err && <p className="err span-2">{err}</p>}
    </>
  );
}
