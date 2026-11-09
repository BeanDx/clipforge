// Курица, которая живёт внизу окна. Гуляет, клюёт, садится, засыпает; следит глазом за курсором.
// Её можно гладить (водить курсором по ней), тыкать (5 раз подряд — обидится и уйдёт за край),
// хватать и бросать. Во время рендера сидит в наушниках, на готовом рендере радуется, на ошибке паникует.
// Иногда несёт яйцо — из него вылупляется цыплёнок и ходит за ней.
// Никогда не стоит на кнопках: если под ней что-то кликабельное — отходит.
// Позиция обновляется напрямую в DOM (без перерисовок React), состояние — классом на обёртке.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useIdle } from "../../lib/idle";
import { useChickenPrefs } from "./prefs";
import { sfx, setSoundOn, unlockAudio } from "./sound";
import { HenSvg, ChickSvg, FEATHER } from "./art";
import "./chicken.css";

const W = 64;        // размер курицы, px
const FLOOR = 6;     // отступ от низа окна
const G = 2400;      // гравитация, px/с²
const WALK = 44;
const RUN = 240;
const CHICK = 28;

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// состояние → классы внешнего вида (несколько состояний делят одну анимацию)
const LOOK = {
  idle: "idle", enter: "walk", walk: "walk", shoo: "walk ck--side", run: "run", flee: "run", panic: "run ck--panic",
  peck: "peck", sit: "sit", sleep: "sit ck--sleep", watch: "sit ck--watch", lay: "sit ck--lay", look: "look",
  air: "air", drag: "air ck--drag", land: "land", dizzy: "dizzy", angry: "angry", hidden: "idle", peek: "peek",
  party: "party", alert: "alert", pet: "pet",
};
const MOVING = new Set(["enter", "walk", "shoo", "run", "flee", "panic"]);
const CALM = new Set(["idle", "walk", "peck", "sit", "look", "pet", "sleep", "watch"]);
const FREE_MODES = new Set(["flee", "hidden", "peek", "enter", "air", "drag"]); // им можно за край окна
const CLICKABLE = "button, a, input, select, textarea, label, summary, [role=button], [role=tab], [contenteditable]";

export function Chicken(props) {
  const prefs = useChickenPrefs();
  useEffect(() => setSoundOn(prefs.sound), [prefs.sound]);
  return prefs.on ? <Hen {...props} /> : null;
}

// Весь «мозг» курицы: состояние, физика, поведение. Создаётся один раз на курицу.
function createEngine(set) {
  const now0 = performance.now();
  const st = {
    x: -W - 10, y: 0, vx: 0, vy: 0, dir: 1, mode: "enter", until: 0,
    tx: rnd(90, Math.max(120, Math.min(420, window.innerWidth - W - 40))), speed: WALK * 1.3, then: null,
    clicks: [], press: null, samples: [], hovering: false, hoverAt: Infinity,
    petAcc: 0, petLast: 0, petT: 0, purrAt: 0, mouse: { x: -1, y: -1, t: 0 },
    activity: now0, flipAt: 0, hopAt: 0, checkAt: now0 + 2000,
    helmet: false, hasEgg: false, hasChick: false, cx: 0, cy: 0, cvy: 0, cdir: 1, timers: new Set(),
  };
  const els = {};
  const E = { st, els, set, live: { rendering: false, over: false } };
  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;
  const later = (fn, ms) => { const id = setTimeout(() => { st.timers.delete(id); fn(); }, ms); st.timers.add(id); return id; };
  const say = (text, ms = 1200) => { set.bubble(text); clearTimeout(st.bubbleT); st.bubbleT = later(() => set.bubble(null), ms); };
  const cluck = (kind = "cluck") => {
    sfx(kind);
    set.talk(true);
    clearTimeout(st.talkT);
    st.talkT = later(() => set.talk(false), kind === "bawk" || kind === "panic" || kind === "party" ? 700 : 240);
  };
  const center = () => ({ x: st.x + W / 2, y: vh() - FLOOR - st.y - W * 0.55 });
  const feathers = (n, power = 1) => {
    const layer = els.fx;
    if (!layer || layer.childElementCount > 60) return;
    const c = center();
    for (let i = 0; i < n; i++) {
      const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05);
      const sp = rnd(50, 150) * power;
      const el = document.createElement("i");
      el.className = "ck-feather";
      el.style.cssText = `left:${c.x + rnd(-10, 10)}px;top:${c.y + rnd(-8, 8)}px;--dx:${Math.cos(a) * sp}px;--dy:${Math.sin(a) * sp}px;` +
        `--fall:${rnd(60, 140)}px;--sw:${rnd(-24, 24)}px;--r0:${rnd(-90, 90)}deg;--r1:${rnd(-320, 320)}deg;--d:${rnd(1.3, 2.3)}s`;
      el.innerHTML = FEATHER;
      el.addEventListener("animationend", () => el.remove());
      layer.appendChild(el);
    }
  };
  const enter = (m, ms = 0) => { st.mode = m; st.until = ms ? performance.now() + ms : 0; set.mode(m); };
  const go = (m, tx, speed, then = null) => { st.tx = tx; st.speed = speed; st.then = then; enter(m); };
  const grounded = () => st.y <= 0 && st.vy === 0;
  const clampX = (x) => clamp(x, 8, Math.max(8, vw() - W - 8));

  // есть ли под курицей что-то кликабельное (кнопка, вкладка, поле)
  const blocked = (x) => {
    const top = vh() - FLOOR - W;
    for (const [fx, fy] of [[0.25, 0.45], [0.5, 0.75], [0.75, 0.45], [0.5, 0.3]]) {
      const px = x + W * fx, py = top + W * fy;
      if (px < 0 || px > vw()) continue;
      for (const el of document.elementsFromPoint(px, py)) {
        if (el.closest(".ck, .ck-chick, .ck-egg, .ck-fx")) continue;
        if (el.closest(CLICKABLE)) return true;
        break; // верхний не-курицын элемент не кликабельный — дальше не смотрим
      }
    }
    return false;
  };
  const freeX = (x) => {
    for (let d = 40; d < vw(); d += 40) {
      for (const c of [x - d, x + d]) {
        const cx = clampX(c);
        if (cx === c && !blocked(cx)) return cx;
      }
    }
    return null;
  };

  const decide = () => {
    const now = performance.now();
    if (E.live.over) return toAlert();
    if (E.live.rendering) return enter("watch");
    if (now - st.activity > 120000) return enter("sleep");
    const r = Math.random();
    if (r < 0.02 && !st.hasEgg && !st.hasChick) return enter("lay", 2400);
    if (r < 0.045 && !st.helmet) {
      st.helmet = true; set.helmet(true);
      later(() => { st.helmet = false; set.helmet(false); }, 40000);
    }
    if (r < 0.5) {
      let tx = clampX(st.x + rnd(60, 320) * (Math.random() < 0.5 ? -1 : 1));
      if (blocked(tx)) tx = freeX(tx) ?? st.x;
      return go("walk", tx, WALK);
    }
    if (r < 0.68) return enter("peck", 1500);
    if (r < 0.8) return enter("sit", rnd(4000, 9000));
    if (r < 0.92) return enter("look", 2000);
    return enter("idle", rnd(1500, 3500));
  };

  const toAlert = () => {
    say("!", 1500);
    sfx("startle");
    go("run", clampX(vw() / 2 - W / 2), RUN, "alert");
  };

  const layEgg = () => {
    st.hasEgg = true;
    set.egg({ x: st.x + W / 2 - 9 - st.dir * 14, cracking: false });
    cluck("cluck");
    later(() => cluck("cluck"), 260);
  };

  const arrive = () => {
    const then = st.then;
    st.then = null;
    if (st.mode === "panic") { st.tx = clampX(rnd(0, vw())); return; } // мечется до конца паники
    if (then === "hidden") return enter("hidden", rnd(3500, 6500));
    if (then === "alert") return enter("alert");
    enter("idle", rnd(1200, 3500));
  };

  const timeout = () => {
    switch (st.mode) {
      case "idle": return decide();
      case "lay": layEgg(); return go("walk", clampX(st.x + (st.dir > 0 ? -1 : 1) * rnd(110, 170)), WALK);
      case "angry": {
        const left = st.x + W / 2 < vw() / 2;
        return go("flee", left ? -W - 30 : vw() + 30, RUN, "hidden");
      }
      case "hidden": {
        const left = st.x < 0;
        st.x = left ? -W * 0.42 : vw() - W * 0.58;
        st.dir = left ? 1 : -1;
        return enter("peek", 1800);
      }
      case "peek": return go("enter", clampX(st.x + st.dir * rnd(130, 230)), WALK);
      default: return enter("idle", rnd(1200, 3000));
    }
  };

  const click = () => {
    const now = performance.now();
    st.activity = now;
    if (st.mode === "sleep") {
      enter("idle", 1800); st.vy = 520;
      say("!", 900); cluck("startle"); feathers(4, 1);
      return;
    }
    if (st.mode === "peek" || st.mode === "hidden") { cluck(); return go("enter", clampX(st.x + st.dir * 170), WALK * 1.5); }
    if (["angry", "flee", "air", "drag", "dizzy", "panic", "party"].includes(st.mode)) { cluck(); return; }
    st.clicks = st.clicks.filter((t) => now - t < 2500);
    st.clicks.push(now);
    if (st.clicks.length >= 5) {
      st.clicks = [];
      enter("angry", 1300); say("#@!", 1300); cluck("bawk"); feathers(6, 1.3);
      return;
    }
    if (st.mode !== "watch" && st.mode !== "alert") enter("idle", rnd(1500, 3000));
    if (grounded()) st.vy = st.clicks.length > 2 ? 440 : 320;
    cluck();
    feathers(1, 0.7);
  };

  const party = (ms = 2600, n = 14) => {
    if (st.mode === "drag") return;
    enter("party", ms); st.hopAt = 0;
    cluck("party"); feathers(n, 1.6);
  };

  const panic = () => {
    if (st.mode === "drag") return;
    st.tx = clampX(rnd(0, vw())); st.speed = RUN; st.then = null;
    enter("panic", 2800);
    say("?!", 1600); cluck("panic"); feathers(6, 1.2);
  };

  const tick = (dt, now) => {
    const VW = vw();
    if (st.mode !== "drag") {
      if (st.y > 0 || st.vy !== 0) {
        st.vy -= G * dt;
        st.y += st.vy * dt;
        const ceil = vh() - FLOOR - W;
        if (st.y > ceil) { st.y = ceil; st.vy = -Math.abs(st.vy) * 0.4; }
        if (st.mode === "air") {
          st.x += st.vx * dt;
          if (st.x < 0) { st.x = 0; st.vx = Math.abs(st.vx) * 0.5; }
          if (st.x > VW - W) { st.x = VW - W; st.vx = -Math.abs(st.vx) * 0.5; }
        }
        if (st.y <= 0) {
          const impact = -st.vy;
          st.y = 0; st.vy = 0;
          if (st.mode === "air") {
            st.vx = 0;
            if (impact > 1150) { enter("dizzy", 2400); cluck("startle"); feathers(5, 1.2); } else enter("land", 380);
          }
        }
      }
      if (MOVING.has(st.mode)) {
        const d = st.tx - st.x;
        const step = st.speed * dt;
        if (Math.abs(d) <= step) { st.x = st.tx; arrive(); } else { st.x += Math.sign(d) * step; st.dir = Math.sign(d); }
      }
      if (st.mode === "party" && st.y === 0 && now > st.hopAt) {
        st.vy = rnd(420, 560); st.hopAt = now + 360;
        if (Math.random() < 0.6) feathers(3, 0.8);
      }
      if (st.mode === "panic" && Math.random() < dt * 3) feathers(1, 0.6);
    }
    if (st.until && now > st.until) timeout();

    // постояла под курсором и её не гладят — отходит, чтобы не мешать
    if (st.hovering && !st.press && now - st.hoverAt > 1700 && ["idle", "sit", "look", "peck"].includes(st.mode)) {
      st.hoverAt = Infinity;
      const away = st.mouse.x < st.x + W / 2 ? 1 : -1;
      go("shoo", clampX(st.x + away * rnd(120, 170)), WALK * 1.7);
    }
    if (st.mode === "pet" && now - st.petT > 700) enter("idle", rnd(800, 1600));

    // раз в секунду: не стоит ли на кнопке
    if (now > st.checkAt) {
      st.checkAt = now + 900;
      if (CALM.has(st.mode) && st.mode !== "walk" && grounded() && blocked(st.x)) {
        const fx = freeX(st.x);
        if (fx != null) go("shoo", fx, WALK * 1.8);
      }
    }

    // поворачивается к курсору, когда стоит
    if (["idle", "sit", "look", "watch", "pet", "alert"].includes(st.mode) && now - st.mouse.t < 2500 && now - st.flipAt > 700) {
      const cx = st.x + W / 2;
      const want = st.mouse.x > cx + 30 ? 1 : st.mouse.x < cx - 30 ? -1 : st.dir;
      if (want !== st.dir) { st.dir = want; st.flipAt = now; }
    }
    if (!FREE_MODES.has(st.mode)) st.x = clamp(st.x, 0, Math.max(0, VW - W));

    // цыплёнок держится чуть позади мамы
    if (st.hasChick && els.chick) {
      const target = clamp(st.x + W / 2 - CHICK / 2 - st.dir * 42, 0, VW - CHICK);
      const d = target - st.cx;
      const moving = Math.abs(d) > 14;
      if (moving) {
        st.cx += Math.sign(d) * Math.min(Math.abs(d), (Math.abs(d) > 120 ? 170 : 85) * dt);
        st.cdir = Math.sign(d);
      } else if (Math.abs(st.x + W / 2 - (st.cx + CHICK / 2)) > 4) {
        st.cdir = st.x + W / 2 > st.cx + CHICK / 2 ? 1 : -1;
      }
      if (st.cy > 0 || st.cvy !== 0) {
        st.cvy -= G * dt; st.cy += st.cvy * dt;
        if (st.cy <= 0) { st.cy = 0; st.cvy = 0; }
      }
      const c = els.chick;
      c.style.transform = `translate3d(${st.cx}px, ${-st.cy}px, 0)`;
      c.style.setProperty("--cdir", st.cdir);
      c.classList.toggle("is-walk", moving);
    }

    apply();
  };

  const apply = () => {
    const el = els.root;
    if (!el) return;
    el.style.transform = `translate3d(${st.x}px, ${-st.y}px, 0)`;
    el.style.setProperty("--dir", st.dir);
    // зрачок смотрит на курсор (в координатах рисунка, с учётом зеркала)
    if (st.mouse.t) {
      const ex = st.x + W * (st.dir > 0 ? 0.69 : 0.31);
      const ey = vh() - FLOOR - st.y - W + W * 0.33;
      const dx = st.mouse.x - ex, dy = st.mouse.y - ey;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / 90) * 1.7;
      el.style.setProperty("--px", ((dx / len) * k * st.dir).toFixed(2));
      el.style.setProperty("--py", ((dy / len) * k).toFixed(2));
    }
    const sh = els.shadow;
    if (sh) {
      const sc = 1 - Math.min(st.y / 320, 0.65);
      sh.style.transform = `translate3d(${st.x}px, 0, 0) scale(${sc.toFixed(3)})`;
      sh.style.opacity = (0.25 + 0.75 * sc).toFixed(2);
    }
  };

  // ——— мышь ———
  const onDown = (e) => {
    if (e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ }
    const top = vh() - FLOOR - st.y;
    st.press = { x: e.clientX, y: e.clientY, ox: e.clientX - st.x, ob: top - e.clientY };
    st.samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    unlockAudio();
  };
  const onMove = (e) => {
    const now = performance.now();
    if (st.press) {
      if (st.mode !== "drag" && Math.hypot(e.clientX - st.press.x, e.clientY - st.press.y) > 6) {
        enter("drag"); st.vy = 0; st.vx = 0; st.activity = now;
        cluck("startle");
      }
      if (st.mode === "drag") {
        st.x = e.clientX - st.press.ox;
        st.y = Math.max(0, vh() - FLOOR - e.clientY - st.press.ob);
        st.samples.push({ x: e.clientX, y: e.clientY, t: now });
        while (st.samples.length > 2 && now - st.samples[0].t > 90) st.samples.shift();
      }
      return;
    }
    // гладят: курсор ёрзает по курице
    const dd = Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
    if (now - st.petLast > 400) st.petAcc = 0;
    st.petLast = now;
    st.petAcc += dd;
    if (st.petAcc > 240 && grounded() && ["idle", "sit", "look", "peck", "walk", "pet", "shoo"].includes(st.mode)) {
      if (st.mode !== "pet") { enter("pet"); sfx("purr"); st.purrAt = now; }
      st.petT = now; st.hoverAt = Infinity; st.activity = now;
      if (now - st.purrAt > 1400) { sfx("purr"); st.purrAt = now; }
    }
  };
  const onUp = () => {
    const p = st.press;
    st.press = null;
    if (!p) return;
    if (st.mode === "drag") {
      const a = st.samples[0], b = st.samples[st.samples.length - 1];
      const dt = Math.max(16, b.t - a.t) / 1000;
      st.vx = clamp((b.x - a.x) / dt, -2600, 2600);
      st.vy = clamp(-(b.y - a.y) / dt, -2600, 2600);
      if (st.y <= 0 && st.vy <= 0) { st.y = 0; st.vy = 0; st.vx = 0; enter("land", 300); return; }
      enter("air");
      if (Math.hypot(st.vx, st.vy) > 1000) cluck("startle");
      return;
    }
    click();
  };
  const onCancel = () => {
    if (st.mode === "drag") { st.vx = 0; st.vy = 0; enter("air"); }
    st.press = null;
  };
  const onEnter = () => { st.hovering = true; st.hoverAt = performance.now(); };
  const onLeave = () => { st.hovering = false; st.hoverAt = Infinity; };

  const hatch = () => {
    unlockAudio();
    set.egg((e) => (e && !e.cracking ? { ...e, cracking: true } : e));
    sfx("pop");
    later(() => {
      set.egg((e) => {
        if (e) { st.cx = e.x - 5; st.cy = 0; st.cvy = 260; }
        return null;
      });
      st.hasEgg = false; st.hasChick = true;
      set.chick(true);
      sfx("peep");
      if (CALM.has(st.mode)) later(() => party(1400, 6), 300);
    }, 520);
  };
  const peep = () => { unlockAudio(); sfx("peep"); if (st.cy === 0) st.cvy = 280; };

  Object.assign(E, {
    tick, apply, enter, go, say, cluck, feathers, party, panic, toAlert, clampX,
    onDown, onMove, onUp, onCancel, onEnter, onLeave, hatch, peep, later,
  });
  return E;
}

function Hen({ rendering = false, progress = 0, over = false, error = "" }) {
  const idle = useIdle();
  const [mode, setMode] = useState("enter");
  const [talk, setTalk] = useState(false);
  const [bubble, setBubble] = useState(null);
  const [helmet, setHelmet] = useState(false);
  const [egg, setEgg] = useState(null);
  const [chick, setChick] = useState(false);
  const api = useRef(null);
  if (api.current == null) {
    api.current = createEngine({ mode: setMode, talk: setTalk, bubble: setBubble, helmet: setHelmet, egg: setEgg, chick: setChick });
  }

  useEffect(() => { api.current.live = { rendering, over }; }, [rendering, over]);

  // кадры анимации — только пока окно в фокусе (в игре курица замирает вместе со всем интерфейсом)
  useEffect(() => {
    if (idle) return;
    const st = api.current.st;
    st.activity = performance.now();
    let raf, last = performance.now();
    const loop = (t) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      api.current.tick(dt, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [idle]);

  // курсор по всему окну: глаз следит, активность не даёт уснуть
  useEffect(() => {
    const st = api.current.st;
    const move = (e) => { st.mouse = { x: e.clientX, y: e.clientY, t: performance.now() }; st.activity = st.mouse.t; };
    const key = () => { st.activity = performance.now(); };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("keydown", key, { passive: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("keydown", key); };
  }, []);

  // рендер: сидит в наушниках; закончился — назад к делам
  useEffect(() => {
    const A = api.current, st = A.st;
    if (rendering) {
      if (CALM.has(st.mode) || st.mode === "peck") { A.enter("watch"); A.say("♪", 1200); }
    } else if (st.mode === "watch") {
      A.enter("idle", 1500);
    }
  }, [rendering]);

  // демку тащат в окно — бежит ловить
  useEffect(() => {
    const A = api.current, st = A.st;
    if (over) {
      if (!["drag", "air", "flee", "hidden", "angry"].includes(st.mode)) A.toAlert();
    } else if (st.mode === "alert" || (st.mode === "run" && st.then === "alert")) {
      A.enter("idle", 1800); st.vy = 380; A.cluck("cluck");
    }
  }, [over]);

  // ошибка — паника
  const prevError = useRef(error);
  useEffect(() => {
    if (error && error !== prevError.current) api.current.panic();
    prevError.current = error;
  }, [error]);

  // готовый рендер — праздник
  useEffect(() => {
    let un = null, dead = false;
    try {
      listen("render-done", () => api.current.party()).then((f) => { if (dead) f(); else un = f; }).catch(() => {});
    } catch { /* не в Tauri (превью в браузере) */ }
    return () => { dead = true; un?.(); };
  }, []);

  // таймеры не переживают размонтирование (выключили курицу в настройках)
  useEffect(() => {
    const st = api.current.st;
    return () => { st.timers.forEach(clearTimeout); st.timers.clear(); };
  }, []);

  // ручки для проверки из консоли в dev-сборке: __chicken.party(), __chicken.panic(), __chicken.egg()
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const A = api.current, st = A.st;
    window.__chicken = {
      party: () => A.party(), panic: () => A.panic(), alert: () => A.toAlert(),
      sleep: () => A.enter("sleep"), watch: () => A.enter("watch"), angry: () => { A.enter("angry", 1300); A.cluck("bawk"); },
      egg: () => A.enter("lay", 2400), helmet: () => { st.helmet = !st.helmet; A.set.helmet(st.helmet); },
      state: () => ({ mode: st.mode, x: Math.round(st.x), y: Math.round(st.y), tx: st.tx, speed: st.speed }),
      // прогнать симуляцию вручную (когда окно не рисует кадры): __chicken.step(2000)
      step: (ms) => { const t0 = performance.now(); for (let t = 0; t < ms; t += 16) A.tick(0.016, t0 + t); },
    };
    return () => { delete window.__chicken; };
  }, []);

  const bubbleText = mode === "watch" ? `${Math.round(progress)}%` : bubble;
  const cls = `ck ck--${LOOK[mode] || mode}${talk ? " ck--talk" : ""}${helmet ? " ck--helmet" : ""}`;

  return (
    <>
      <div className="ck-fx" ref={(el) => { api.current.els.fx = el; }} aria-hidden="true" />
      <div className="ck-shadow" ref={(el) => { api.current.els.shadow = el; }} aria-hidden="true" />
      {egg && (
        <div role="button" tabIndex={-1} aria-label="egg" className={`ck-egg${egg.cracking ? " is-crack" : ""}`}
          style={{ left: egg.x }} onClick={() => api.current.hatch()} />
      )}
      {chick && <div className="ck-chick" ref={(el) => { api.current.els.chick = el; }} onPointerDown={() => api.current.peep()}><ChickSvg /></div>}
      <div className={cls} ref={(el) => { api.current.els.root = el; }}>
        {bubbleText && <span className="ck__bubble mono" key={bubbleText.length > 2 ? "p" : bubbleText}>{bubbleText}</span>}
        {mode === "sleep" && <span className="ck__zzz mono" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>}
        <div className="ck__flip"><div className="ck__squash"><HenSvg /></div></div>
        <div className="ck__hit"
          onPointerDown={(e) => api.current.onDown(e)} onPointerMove={(e) => api.current.onMove(e)}
          onPointerUp={() => api.current.onUp()} onPointerCancel={() => api.current.onCancel()}
          onPointerEnter={() => api.current.onEnter()} onPointerLeave={() => api.current.onLeave()}
          onContextMenu={(e) => e.preventDefault()} />
      </div>
    </>
  );
}
