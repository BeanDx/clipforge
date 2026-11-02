// Вкладка «Эдит»: пресеты эдитов из нескольких демок. Пока один — Night Edit (как ночные TikTok-эдиты):
// интро ночью — звёздное небо с луной, сиреневый текст песни с сердцем, светящаяся пыль, рамка на цели,
// светящееся оружие; дальше дневной монтаж лучших киллов, каждый ровно на удар трека.
import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tr, useLang } from "./i18n";
import { drawLyricStyle, wordsOf, heartWord, lyricFont } from "./lyricStyles";
import { drawDust, drawTargets, buildSkyPano, drawSky } from "./nightfx";
import { editKills, commonPlayer, flickOf, scoreKill, groupKills, clipOf, partInfo, planMontage } from "./montage";
import { mapName } from "./dossier";
import previewBg from "./assets/previews/lyrics-bg.webp";

const SNIPER_OR_KNIFE = /awp|ssg08|knife|bayonet/;
const WEAPON = (w) => ({ ssg08: "SSG 08", awp: "AWP", ak47: "AK-47", m4a1_silencer: "M4A1-S", m4a1: "M4A4", deagle: "Deagle", usp_silencer: "USP-S", glock: "Glock" }[w] || w.replace(/_/g, " ").toUpperCase());
const MAX_PICK = 14;

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

export function NightEdit({ Frame, Hint, archive, cs2, hlae, out, music, video, playerId, rendering, progress, stage, renderPart, onDone, onGoSound }) {
  const [replays, setReplays] = useState([]);
  const [chosen, setChosen] = useState(() => new Set());
  const [scan, setScan] = useState(null); // { me, groups: [...] }
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [intro, setIntro] = useState(null);
  const [result, setResult] = useState(null);
  const cancel = useRef(false);
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

  const musicReady = music.enabled && music.path;
  const lyricsReady = musicReady && music.showLyrics && music.lrc;

  // поиск моментов: разбор каждой демки, киллы игрока, флик по углам камеры, оценка
  const findMoments = async () => {
    setErr(""); setBusy(tr("разбираю демки...")); setScan(null); setResult(null);
    try {
      const paths = [...chosen];
      const raws = [];
      for (let i = 0; i < paths.length; i++) {
        setBusy(tr("разбираю демку {0}/{1}...", i + 1, paths.length));
        raws.push(JSON.parse(await invoke("parse_demo", { path: paths[i] })));
      }
      const me = commonPlayer(raws, playerId);
      if (!me) throw new Error(tr("Не нашел игрока, который есть во всех выбранных демках. Выбери демки одного аккаунта."));
      const groups = [];
      for (let i = 0; i < paths.length; i++) {
        setBusy(tr("ищу флики: демка {0}/{1}...", i + 1, paths.length));
        const raw = raws[i];
        const kills = editKills(raw, me);
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
      const top = groups.slice(0, 10);
      setScan({ me, groups });
      setPicked(new Set(top.map((g) => g.id)));
      setIntro((top.find((g) => g.special) || top[0])?.id ?? null);
    } catch (e) { setErr(String(e.message || e)); }
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
  const estSec = sel.length ? Math.round(8 + sel.filter((g) => g !== introG).reduce((s, g) => s + 0.8 + g.kills.length * 0.6, 0)) : 0;
  const demoCount = new Set(sel.map((g) => g.demo)).size;
  const canBuild = sel.length >= 2 && musicReady && !rendering && !busy && hlae && cs2 && out;

  const sig = sel.map((g) => g.id).join("|") + "#" + (introG?.id || "");
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
      let n = 0;
      for (const [demoPath, gs] of byDemo) {
        n++;
        // клипы одной демки — по порядку в демке: игра проигрывает её вперёд
        gs.sort((a, b) => a.kills[0].tick - b.kills[0].tick);
        const clips = gs.map((g) => clipOf(g, { steamid: scan.me, name: g.name, slot: g.slot, intro: g === introG }));
        const dir = await join(base, `d${n}`);
        if (!doneDemos.has(demoPath)) {
          if (n > 1 || resumable) { setBusy(tr("жду, пока CS2 закроется...")); await waitGameClosed(); }
          setBusy(tr("запись демки {0}/{1}: в игре нажми F10, когда демка загрузится", n, byDemo.size));
          await renderPart({ demoPath, steamid: scan.me, roster: gs[0].roster, clips, partsDir: dir });
          doneDemos.set(demoPath, dir);
        }
        for (let i = 0; i < gs.length; i++) {
          parts.push({ g: gs[i], path: await join(dir, `part_${String(i).padStart(2, "0")}.mp4`), info: partInfo(clips[i]) });
        }
      }
      setBusy(tr("собираю эдит под бит..."));
      // порядок: интро, потом по нарастающей — самые крутые киллы в конце
      const intro0 = parts.find((p) => p.g === introG);
      const rest = parts.filter((p) => p !== intro0).sort((a, b) => a.g.score - b.g.score);
      const order = [intro0, ...rest].filter(Boolean).map((p) => ({ path: p.path, dur: p.info.dur, kills: p.info.kills, intro: p === intro0 }));
      const beats = await invoke("track_beats", { hlae, path: music.path, offset: music.start, dur: 240 }).catch(() => []);
      const plan = planMontage(order, beats);
      const file = await join(out, `${stamp.replace("_", " ")} night edit.mp4`);
      await invoke("build_montage", { m: {
        hlae, out: file, fps: video.fps, width: video.width, height: video.height, crf: video.crf, gpuEncoder: video.gpu,
        segments: plan.segments, whips: plan.whips, punches: plan.punches,
        music: { path: music.path, start: music.start, musicVol: music.musicVol, gameVol: Math.min(music.gameVol, 0.55) },
      } });
      setResult({ file, total: plan.total, kills: plan.punches.length });
      doneRef.current = null;
      onDone?.(file);
    } catch (e) {
      const left = byDemoCount() - (doneRef.current?.demos.size || 0);
      setErr(String(e.message || e) + (doneRef.current?.demos.size ? " · " + tr("записанные демки сохранены: нажми «Продолжить сборку», осталось {0}", left) : ""));
    }
    setBusy("");
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
            <span className="mono dim">{lyricsReady ? tr("с текстом · стиль Night в интро") : tr("без текста: в интро будет только музыка")}</span>
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
          <div className="ne-kills">
            {scan.groups.slice(0, 40).map((g, i) => {
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
          <div className="ne-build__row">
            <div className="ne-build__sum">
              <b>{tr("{0} моментов", sel.length)}</b>
              <span className="dim">{tr("интро: {0}", introG ? `${WEAPON(introG.weapon)} · ${mapName(introG.map) || "demo"} R${introG.round}` : "-")}</span>
              <span className="dim">{tr("Каждая демка пишется отдельно: когда она загрузится в игре, нажми F10.")}</span>
            </div>
            <button type="button" className="go ne-go" disabled={!canBuild} onClick={build}>{resumable ? tr("Продолжить сборку") : tr("Собрать эдит")}</button>
          </div>
          {(busy || rendering) && (
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
