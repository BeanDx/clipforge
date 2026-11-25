// Окно 3D-превью момента: карта из установленной CS2, игроки-манекены по демке, камера глазами
// игрока и облёт после килла (тот же путь mirv_campath, что уйдёт в HLAE). Только смотрит:
// на рендер и настройки не влияет.
import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tr, trError } from "../../i18n";
import { orbitPath } from "../demo/cine";
import { Scene3D } from "./engine";
import { weaponModel } from "./weapons";
import Killfeed from "./Killfeed";
import "./scene3d.css";

const TICKRATE = 64;
// чей голос слушать: свои, соперники, все или никто
const VOICE_MODES = ["team", "enemy", "all", "off"];
const VOICE_KEY = "cf-s3d-voice";
const savedVoice = () => { try { const v = localStorage.getItem(VOICE_KEY); return VOICE_MODES.includes(v) ? v : "team"; } catch { return "team"; } };

// base64 Ogg Opus → <audio>: сам тянет звук и держит высоту голоса на 0.5× и 0.25×
function phraseAudio(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/ogg" }));
  const a = new Audio(url);
  a.preload = "auto";
  a.preservesPitch = true;
  return { a, url };
}

export default function Scene3DModal({ demoPath, steamid, clip, map, cs2, fov, orbitOn, onClose }) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [stage, setStage] = useState(tr("Готовлю карту..."));
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("pov");
  const [hasOrbit, setHasOrbit] = useState(false);
  const [tick, setTick] = useState(clip.start);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [feed, setFeed] = useState(null); // { kills, team: Map(steamid → команда) }
  const [iconDir, setIconDir] = useState(null);
  const [mapLabel, setMapLabel] = useState(map || "");
  const [stats, setStats] = useState(null);
  const [voice, setVoice] = useState(null); // null — ещё читается; [] — голоса в демке нет
  const [voiceMode, setVoiceMode] = useState(savedVoice);
  const [speaking, setSpeaking] = useState([]); // steamid тех, кто говорит прямо сейчас
  const voiceRef = useRef([]); // фразы с <audio>
  const playRef = useRef({ playing: false, speed: 1, tick: clip.start, talking: "", allow: () => false });

  // загрузка: карта, игроки, путь облёта
  useEffect(() => {
    let dead = false;
    const un = listen("scene3d-progress", (e) => {
      const [kind, done, total] = e.payload;
      if (kind === "download") setStage(tr("Скачиваю Source 2 Viewer... {0} / {1} МБ", Math.round(done), Math.round(total) || "?"));
      else if (kind === "slim") setStage(tr("Готовлю карту для превью (один раз)..."));
      else setStage(tr("Выгружаю карту из CS2 (один раз)..."));
    });
    const scene = new Scene3D(canvasRef.current);
    sceneRef.current = scene;
    scene.fov = fov;
    (async () => {
      try {
        let m = map;
        if (!m) m = await invoke("demo_header", { path: demoPath }).catch(() => "");
        if (!m) throw new Error(tr("Не удалось узнать карту демки"));
        setMapLabel(m);
        const mapFile = await invoke("scene_map", { cs2, map: m });
        if (dead) return;
        setStage(tr("Читаю игроков из демки..."));
        const data = JSON.parse(await invoke("scene_players", { path: demoPath, start: clip.start, end: clip.end, steamid: String(steamid) }));
        if (dead) return;
        setStage(tr("Загружаю геометрию..."));
        await scene.loadMap(convertFileSrc(mapFile), (l, t) => {
          if (!dead) setStage(tr("Загружаю геометрию... {0}%", t ? Math.round((l / t) * 100) : Math.round(l / 1048576)));
        });
        if (dead) return;
        scene.setPlayers(data, steamid);
        setFeed({ kills: data.kills || [], team: new Map(data.players.map((p) => [p.id, p.team])), name: new Map(data.players.map((p) => [p.id, p.name])) });
        // иконки киллфида из игры; не вышло — останутся названия оружия текстом
        invoke("scene_icons", { cs2 }).then((d) => { if (!dead) setIconDir(d); }).catch(() => {});
        // модели оружия выгружаются из игры по мере надобности (первый раз — пара секунд на ствол)
        scene.weaponSource = async (name) => {
          const model = weaponModel(name);
          if (!model) return null;
          const glb = await invoke("scene_weapon", { cs2, model });
          const dir = glb.replace(/[\\/][^\\/]+$/, "");
          return { url: convertFileSrc(glb), resolve: (file) => convertFileSrc(`${dir}\\${file}`) };
        };
        // все стволы клипа — до показа: иначе первые секунды игрок «без оружия», пока оно выгружается
        await scene.preloadWeapons((d, t) => { if (!dead && t) setStage(tr("Загружаю модели оружия... {0} / {1}", d, t)); });
        if (dead) return;
        // полёт гранат читается дольше всего остального — дорисуется, когда придёт
        invoke("scene_grenades", { path: demoPath, start: clip.start, end: clip.end })
          .then((j) => { if (!dead) scene.setFlights(JSON.parse(j).nades); })
          .catch((e) => console.warn("3D: гранаты", e));
        // голосовой чат: есть в демках FACEIT и комьюнити-серверов, у матчмейкинга Valve его нет
        invoke("scene_voice", { path: demoPath, start: clip.start, end: clip.end })
          .then((list) => {
            if (dead) return;
            voiceRef.current = list.map((p) => ({ id: p.id, tick: p.tick, dur: p.dur, ...phraseAudio(p.ogg) }));
            setVoice(list.map(({ id, tick, dur }) => ({ id, tick, dur })));
          })
          .catch((e) => { console.warn("3D: голос", e); if (!dead) setVoice([]); });
        const kill = clip.killTicks?.[clip.killTicks.length - 1];
        if (kill != null) {
          const cine = await invoke("parse_cine", { path: demoPath, steamid, kills: JSON.stringify([kill]) }).then(JSON.parse).catch(() => null);
          const orbit = cine?.[0] ? orbitPath(cine[0], kill, clip.end, fov) : null;
          if (orbit && !dead) { scene.setOrbit(orbit.xml, cine[0].offset); setHasOrbit(true); if (orbitOn) { setMode("orbit"); scene.setMode("orbit"); } }
        }
        scene.setTick(clip.start);
        setReady(true);
        setPlaying(true);
      } catch (e) {
        if (!dead) setError(trError(String(e?.message || e)));
      }
    })();
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(canvasRef.current.parentElement);
    return () => {
      dead = true;
      ro.disconnect();
      un.then((f) => f());
      for (const v of voiceRef.current) { v.a.pause(); URL.revokeObjectURL(v.url); }
      voiceRef.current = [];
      scene.dispose();
      sceneRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // проигрывание по времени демки
  useEffect(() => { playRef.current.playing = playing; playRef.current.speed = speed; }, [playing, speed]);
  // фильтр голоса: свои — та же команда, что у игрока клипа
  useEffect(() => {
    try { localStorage.setItem(VOICE_KEY, voiceMode); } catch { /* приватное окно */ }
    const mine = feed?.team.get(String(steamid));
    playRef.current.allow = (id) => {
      if (voiceMode === "all") return true;
      if (voiceMode === "off" || !feed) return false;
      const t = feed.team.get(id);
      return t != null && (voiceMode === "team" ? t === mine : t !== mine);
    };
  }, [voiceMode, feed, steamid]);
  useEffect(() => {
    if (!ready) return;
    let raf = 0, last = performance.now(), shown = 0;
    const step = (now) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = playRef.current;
      if (p.playing) {
        p.tick += dt * TICKRATE * p.speed;
        if (p.tick >= clip.end) p.tick = clip.start; // по кругу
        sceneRef.current?.setTick(p.tick);
        if (now - shown > 66) { shown = now; setTick(p.tick); }
      }
      // голос идёт за временем демки: фраза звучит, пока её отрезок под ползунком
      const talking = [];
      for (const v of voiceRef.current) {
        const at = (p.tick - v.tick) / TICKRATE;
        const on = at >= 0 && at < v.dur && p.allow(v.id);
        if (on) talking.push(v.id);
        if (on && p.playing) {
          v.a.playbackRate = p.speed;
          if (v.a.paused) { v.a.currentTime = at; v.a.play().catch(() => {}); }
          else if (Math.abs(v.a.currentTime - at) > 0.25) v.a.currentTime = at;
        } else if (!v.a.paused) v.a.pause();
      }
      const key = [...new Set(talking)].join();
      if (key !== p.talking) { p.talking = key; setSpeaking(key ? key.split(",") : []); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ready, clip.start, clip.end]);

  // инфо-панель: 4 раза в секунду, чаще читать незачем
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => { const s = sceneRef.current?.stats(); if (s) setStats(s); }, 250);
    return () => clearInterval(id);
  }, [ready]);

  const seek = (t) => { playRef.current.tick = t; sceneRef.current?.setTick(t); setTick(t); };
  const pickMode = (m) => { setMode(m); sceneRef.current?.setMode(m); };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " " && ready) { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, onClose]);

  const len = clip.end - clip.start;
  const sec = (t) => ((t - clip.start) / TICKRATE).toFixed(1);
  const modes = [
    ["pov", tr("Глазами игрока")],
    ...(hasOrbit ? [["orbit", tr("С облётом")]] : []),
    ["free", tr("Свободная камера")],
  ];

  return (
    <div className="s3d" role="dialog" aria-modal="true" aria-label={tr("3D-превью")} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="s3d__box">
        <div className="s3d__head">
          <h3>{tr("3D-превью")}</h3>
          <span className="mono dim">R{String(clip.round).padStart(2, "0")} · {clip.name}</span>
          <span className="chips__spacer" />
          <div className="ratios" role="radiogroup" aria-label={tr("Камера")}>
            {modes.map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? "is-on" : ""}
                disabled={!ready} onClick={() => pickMode(k)}>{l}</button>
            ))}
          </div>
          <button type="button" className="sk-x" onClick={onClose} aria-label={tr("Закрыть")}>×</button>
        </div>
        <div className="s3d__view">
          <canvas ref={canvasRef} />
          <div className="s3d__scope" aria-hidden="true">
            <svg viewBox="0 0 100 100">
              <path d="M0 50H100M50 0V100" stroke="#000" strokeWidth=".22" />
              <path d="M0 50H34M66 50H100M50 0V34M50 66V100" stroke="#000" strokeWidth="1.1" />
            </svg>
          </div>
          <svg className="s3d__cross" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v7M12 15v7M2 12h7M15 12h7" stroke="rgba(0,0,0,.8)" strokeWidth="4" strokeLinecap="square" />
            <path d="M12 3v5M12 16v5M3 12h5M16 12h5" stroke="#4cff4c" strokeWidth="2" strokeLinecap="butt" />
          </svg>
          {!ready && (
            <div className="s3d__wait">
              {error ? <p className="s3d__err">{error}</p> : <><i className="s3d__spin" /><span className="mono">{stage}</span></>}
            </div>
          )}
          {ready && stats && (
            <div className="s3d-info mono" aria-label={tr("Информация")}>
              <div><b className={stats.fps >= 60 ? "is-good" : stats.fps >= 30 ? "is-mid" : "is-bad"}>{stats.fps}</b> FPS <span>· {stats.ms.toFixed(1)} {tr("мс")}</span></div>
              <div>{mapLabel.replace(/^.*[\\/]/, "")} · R{clip.round} · {tr("тик")} {Math.round(tick)}</div>
              {stats.hp != null && (
                <div>{stats.held || "-"} · HP <b className={stats.hp > 50 ? "is-good" : stats.hp > 20 ? "is-mid" : "is-bad"}>{stats.hp}</b> · {stats.speed} u/s</div>
              )}
              {stats.alive && <div><span className="s3d-kf__t">T {stats.alive[2]}</span> : <span className="s3d-kf__ct">{stats.alive[3]} CT</span></div>}
              <div><span>{(stats.tris / 1e6).toFixed(2)}M {tr("треуг.")} · {stats.calls} {tr("вызовов")}</span></div>
            </div>
          )}
          {ready && feed && (
            <Killfeed kills={feed.kills} tick={tick} me={String(steamid)} teamOf={(id) => feed.team.get(id)} iconDir={iconDir} />
          )}
          {ready && speaking.length > 0 && feed && (
            <div className="s3d-voice" aria-live="polite">
              {speaking.map((id) => {
                const t = feed.team.get(id);
                return <span key={id} className={`s3d-voice__who ${t === 2 ? "is-t" : t === 3 ? "is-ct" : ""}`}><i />{feed.name.get(id) || id}</span>;
              })}
            </div>
          )}
          {ready && mode === "free" && <span className="s3d__hint mono dim">{tr("мышь - вращать, колесо - приблизить, ПКМ - сдвинуть. Жёлтая линия - путь облёта")}</span>}
        </div>
        <div className="s3d__bar">
          <button type="button" className="s3d__play" disabled={!ready} onClick={() => setPlaying((p) => !p)} aria-label={playing ? tr("Пауза") : tr("Играть")}>
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="s3d__track">
            <input type="range" min={clip.start} max={clip.end} step={1} value={Math.round(tick)} disabled={!ready}
              onChange={(e) => seek(Number(e.target.value))} aria-label={tr("Время клипа")} />
            {(clip.killTicks || []).map((k) => (
              <i key={k} className="s3d__kill" style={{ left: `${((k - clip.start) / len) * 100}%` }} title={tr("Килл")} />
            ))}
          </div>
          <span className="mono dim s3d__time">{sec(tick)} / {sec(clip.end)} {tr("сек")}</span>
          <div className="ratios" role="radiogroup" aria-label={tr("Скорость")}>
            {[0.25, 0.5, 1].map((s) => (
              <button key={s} type="button" role="radio" aria-checked={speed === s} className={speed === s ? "is-on" : ""} onClick={() => setSpeed(s)}>{s}×</button>
            ))}
          </div>
          {voice?.length > 0 && (
            <div className="ratios s3d__voice" role="radiogroup" aria-label={tr("Голосовой чат")} title={tr("Голосовой чат из демки")}>
              {[["team", tr("Свои")], ["enemy", tr("Соперники")], ["all", tr("Все")], ["off", tr("Без голоса")]].map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={voiceMode === k} className={voiceMode === k ? "is-on" : ""} onClick={() => setVoiceMode(k)}>{l}</button>
              ))}
            </div>
          )}
          {voice?.length === 0 && (
            <span className="mono dim s3d__novoice" title={tr("Valve не записывает голос в демки матчмейкинга и Premier. Голос есть в демках FACEIT и комьюнити-серверов")}>{tr("без голоса")}</span>
          )}
        </div>
        <p className="s3d__note dim">{tr("Упрощённая карта без текстур и манекены вместо моделей - чтобы заранее увидеть, куда смотрит камера. На запись не влияет.")}</p>
      </div>
    </div>
  );
}
