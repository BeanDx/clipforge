// 3D-сцена превью: карта (glb из Source 2 Viewer), игроки-капсулы, камера глазами игрока,
// облёт по точкам mirv_campath и свободная камера. Всё в координатах Source (x, y — пол, z вверх,
// дюймы), чтобы позиции и углы из демки шли без пересчёта.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const TICKRATE = 64;
const T_COLOR = 0xe8a33d, CT_COLOR = 0x5b9cf0, ME_COLOR = 0x2ee6c0;

// fov игры — горизонтальный при 4:3, у three.js — вертикальный
export const vfov = (fov) => (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * 0.75) * 180) / Math.PI;

const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;

// направление взгляда по углам Source: pitch вниз положительный
function dir(pitch, yaw, out = new THREE.Vector3()) {
  const p = (pitch * Math.PI) / 180, y = (yaw * Math.PI) / 180;
  return out.set(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
}

function label(text, color) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = "600 34px system-ui, sans-serif";
  ctx.font = font;
  const w = Math.min(512, Math.ceil(ctx.measureText(text).width) + 24);
  c.width = w; c.height = 48;
  ctx.font = font;
  ctx.fillStyle = "rgba(7,9,13,.7)";
  ctx.fillRect(0, 0, w, 48);
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 12, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  // постоянный размер на экране: близкие подписи не закрывают кадр, дальние не пропадают
  s.scale.set((w / 48) * 0.03, 0.03, 1);
  s.renderOrder = 10;
  return s;
}

// вспышка у дула: мягкое пятно с аддитивным смешиванием
let flashTex = null;
function flashTexture() {
  if (flashTex) return flashTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,235,1)");
  g.addColorStop(0.25, "rgba(255,210,110,.95)");
  g.addColorStop(0.6, "rgba(255,140,40,.35)");
  g.addColorStop(1, "rgba(255,120,20,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  flashTex = new THREE.CanvasTexture(c);
  flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}
const flashSprite = (size) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.set(size, size, 1);
  s.visible = false;
  return s;
};
const SHOT_TICKS = 5; // столько тиков после выстрела видна вспышка (~80 мс)

function dummy(color, name, me) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: me ? 0.35 : 0.15 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(14, 40, 4, 12), mat);
  body.rotation.x = Math.PI / 2; // капсула three.js вдоль y — ставим вдоль z
  body.position.z = 34;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(9, 14, 10), mat);
  head.position.z = 66;
  g.add(head);
  // «нос» — куда смотрит игрок
  const nose = new THREE.Mesh(new THREE.BoxGeometry(18, 4, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  nose.position.set(12, 0, 64);
  g.add(nose);
  const tag = label(name, me ? "#2ee6c0" : color === T_COLOR ? "#f0b860" : "#8cbcff");
  tag.position.z = 92;
  g.add(tag);
  const flash = flashSprite(26);
  flash.position.set(30, 0, 60);
  g.add(flash);
  g.userData = { body, head, nose, tag, mat, flash };
  return g;
}

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fb4c8);
    this.scene.fog = new THREE.Fog(0x9fb4c8, 3000, 12000);
    this.camera = new THREE.PerspectiveCamera(vfov(90), 16 / 9, 2, 40000);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x5a4a38, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.8);
    sun.position.set(0.4, 0.25, 1);
    this.scene.add(sun);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
    this.mode = "pov";
    this.tick = 0;
    this.dummies = new Map();
    this.pathLine = null;
    this.orbit = null; // { pts: [{tick, x, y, z, pitch, yaw, fov}], start, end }
    this.fov = 90;
    // оружие в руках: своя сцена и камера поверх кадра (как viewmodel в игре — не уходит в стены)
    this.vmScene = new THREE.Scene();
    this.vmCam = new THREE.PerspectiveCamera(vfov(68), 16 / 9, 0.01, 10);
    this.vmScene.add(new THREE.HemisphereLight(0xffffff, 0x444040, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.5, 1, 0.6);
    this.vmScene.add(key);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.vmScene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.vmScene.environmentIntensity = 0.55;
    this.weapons = new Map(); // имя → Object3D | null (загружается / нет модели)
    this.weaponSource = null; // async (name) => { url, resolve(file) } | null
    this.heldShown = null;
    this.view = "";
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false; // кадр — это две отрисовки (мир и оружие), считаем их вместе
    this.raf = 0;
    this.loop = this.loop.bind(this);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCam.aspect = w / h;
    this.vmCam.updateProjectionMatrix();
  }

  // оружие в руках игрока клипа на тике (data.weapons — смены по кадрам)
  heldAt(tick) {
    const w = this.data?.weapons;
    if (!w?.length) return null;
    const fi = (tick - this.data.start) / this.data.step;
    let name = w[0][1];
    for (const [i, n] of w) { if (i <= fi) name = n; else break; }
    return name;
  }

  async loadWeapon(name) {
    this.weapons.set(name, null);
    try {
      const src = await this.weaponSource?.(name);
      if (!src) return;
      const manager = new THREE.LoadingManager();
      // текстуры лежат рядом с glb: адрес каждой строит вызывающий (в Tauri — asset-протокол)
      manager.setURLModifier((u) => (u === src.url || u.startsWith("blob:") || u.startsWith("data:") ? u : src.resolve(decodeURIComponent(u.split("/").pop()))));
      const gltf = await new GLTFLoader(manager).loadAsync(src.url);
      const root = gltf.scene;
      // у моделей CS2 две версии: legacy и HD — оставляем одну
      const hasLegacy = root.children.some((c) => /body_legacy/.test(c.name));
      if (hasLegacy) root.children.forEach((c) => { if (/body_hd/.test(c.name)) c.visible = false; });
      root.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 1; } });
      // glTF Source 2 Viewer: +z — вперёд по стволу, +y — вверх, +x — влево; в камере вперёд — это -z
      const g = new THREE.Group();
      root.rotation.y = Math.PI;
      g.add(root);
      // дуло: передний край модели (после поворота — самый дальний по -z)
      g.updateMatrixWorld(true);
      const box = new THREE.Box3();
      root.traverse((o) => { if (o.isMesh && o.visible && o.parent?.visible !== false) box.expandByObject(o); });
      const flash = flashSprite(0.09);
      if (!box.isEmpty()) flash.position.set((box.min.x + box.max.x) / 2, box.max.y - (box.max.y - box.min.y) * 0.18, box.min.z - 0.02);
      g.add(flash);
      g.userData.flash = flash;
      this.weapons.set(name, g);
    } catch (e) {
      console.warn("3D: оружие", name, e);
    }
  }

  // карта из scripts/slim-map.cjs: уже в координатах Source, один меш
  async loadMap(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`карта не загрузилась (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(got, total);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const ch of chunks) { buf.set(ch, o); o += ch.length; }
    const dv = new DataView(buf.buffer);
    if (String.fromCharCode(...buf.subarray(0, 4)) !== "S3D1") throw new Error("неизвестный формат карты");
    const V = dv.getUint32(4, true), I = dv.getUint32(8, true);
    let off = 16;
    const pos = new Float32Array(buf.buffer, off, V * 3); off += V * 12;
    const nrm = new Int8Array(buf.buffer, off, V * 4); off += V * 4;
    const idx = new Uint32Array(buf.buffer, off, I);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(nrm, 4), 3, 0, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc9bea9, side: THREE.DoubleSide });
    this.map = new THREE.Mesh(g, mat);
    this.scene.add(this.map);
  }

  // data — вывод scripts/scene.cjs; me — steamid игрока клипа
  setPlayers(data, me) {
    this.data = data;
    this.me = String(me);
    // выстрелы по игрокам: отсортированные тики
    this.shots = new Map();
    for (const [tick, id] of data.shots || []) {
      if (!this.shots.has(id)) this.shots.set(id, []);
      this.shots.get(id).push(tick);
    }
    for (const l of this.shots.values()) l.sort((a, b) => a - b);
    // трассеры: по одной линии на игрока
    this.tracers = new Map();
    const tmat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    for (const p of data.players) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), tmat.clone());
      l.visible = false;
      l.frustumCulled = false;
      this.scene.add(l);
      this.tracers.set(p.id, l);
    }
    for (const p of data.players) {
      const isMe = p.id === this.me;
      const d = dummy(isMe ? ME_COLOR : p.team === 2 ? T_COLOR : CT_COLOR, p.name, isMe);
      this.scene.add(d);
      this.dummies.set(p.id, d);
    }
  }

  // Точки XML mirv_campath → тики демки
  setOrbit(xml, offset) {
    if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine = null; }
    this.orbit = null;
    if (!xml) return;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const pts = [...doc.querySelectorAll("p")].map((p) => ({
      tick: (Number(p.getAttribute("t")) - offset) * TICKRATE,
      x: +p.getAttribute("x"), y: +p.getAttribute("y"), z: +p.getAttribute("z"),
      pitch: +p.getAttribute("ry"), yaw: +p.getAttribute("rz"), fov: +p.getAttribute("fov") || 90,
    }));
    if (pts.length < 2) return;
    this.orbit = { pts, start: pts[0].tick, end: pts[pts.length - 1].tick };
    const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    this.pathLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf5c518, depthTest: false }));
    this.pathLine.renderOrder = 9;
    this.scene.add(this.pathLine);
  }

  // состояние игрока на (дробном) тике
  stateAt(p, tick) {
    const { step, start } = this.data;
    const fi = (tick - start) / step;
    const i = Math.max(0, Math.min(p.f.length - 1, Math.floor(fi)));
    let a = p.f[i], b = p.f[Math.min(p.f.length - 1, i + 1)];
    if (!a) a = b;
    if (!b) b = a;
    if (!a) return null;
    const f = Math.max(0, Math.min(1, fi - i));
    return {
      x: lerp(a[0], b[0], f), y: lerp(a[1], b[1], f), z: lerp(a[2], b[2], f),
      pitch: lerp(a[3], b[3], f), yaw: lerpAngle(a[4], b[4], f), alive: a[5], duck: lerp(a[6], b[6], f), hp: a[7] ?? null,
    };
  }

  orbitAt(tick) {
    const o = this.orbit;
    if (!o || tick < o.start || tick > o.end) return null;
    const pts = o.pts;
    let i = 1;
    while (i < pts.length - 1 && pts[i].tick < tick) i++;
    const a = pts[i - 1], b = pts[i];
    const f = Math.max(0, Math.min(1, (tick - a.tick) / (b.tick - a.tick || 1)));
    return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), pitch: lerp(a.pitch, b.pitch, f), yaw: lerpAngle(a.yaw, b.yaw, f), fov: lerp(a.fov, b.fov, f) };
  }

  setMode(mode) {
    if (mode === "free" && this.mode !== "free") {
      // свободная камера начинает позади и над игроком, выше крыш: ниже легко оказаться внутри здания
      const s = this.data && this.stateAt(this.data.players.find((p) => p.id === this.me) || this.data.players[0], this.tick);
      if (s) {
        const back = dir(0, s.yaw).multiplyScalar(-480);
        this.camera.position.set(s.x + back.x, s.y + back.y, s.z + 720);
        this.controls.target.set(s.x, s.y, s.z + 40);
      }
      this.camera.fov = vfov(90);
      this.camera.updateProjectionMatrix();
    }
    this.mode = mode;
    this.controls.enabled = mode === "free";
  }

  setTick(tick) { this.tick = tick; }

  // сколько тиков прошло с последнего выстрела игрока (Infinity — давно не стрелял)
  sinceShot(id, tick) {
    const l = this.shots?.get(id);
    if (!l?.length) return Infinity;
    let lo = 0, hi = l.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (l[m] <= tick) { best = m; lo = m + 1; } else hi = m - 1; }
    return best < 0 ? Infinity : tick - l[best];
  }

  // вспышка у дула и трассер на SHOT_TICKS тиков после выстрела
  shotFx(p, s, d, t) {
    const since = this.sinceShot(p.id, t);
    const on = since < SHOT_TICKS;
    const k = on ? 1 - since / SHOT_TICKS : 0;
    d.userData.flash.visible = on && !(p.id === this.me && this.view === "pov");
    if (on) { const sc = 18 + 16 * k; d.userData.flash.scale.set(sc, sc, 1); d.userData.flash.material.opacity = k; }
    const tr = this.tracers.get(p.id);
    if (!tr) return;
    tr.visible = on;
    if (!on) return;
    const eye = new THREE.Vector3(s.x, s.y, s.z + 64 - 18 * s.duck);
    const fwd = dir(s.pitch, s.yaw);
    // трассер летит от ствола: короткий отрезок, уходящий вперёд по мере «полёта» пули
    const from = eye.clone().addScaledVector(fwd, 30 + since * 320);
    const to = eye.clone().addScaledVector(fwd, 30 + since * 320 + 260);
    if (p.id === this.me && this.view === "pov") { from.z -= 6; to.z -= 3; }
    const a = tr.geometry.attributes.position;
    a.setXYZ(0, from.x, from.y, from.z);
    a.setXYZ(1, to.x, to.y, to.z);
    a.needsUpdate = true;
    tr.material.opacity = 0.35 + 0.6 * k;
  }

  update() {
    if (!this.data) return;
    const t = this.tick;
    let pov = null;
    for (const p of this.data.players) {
      const d = this.dummies.get(p.id);
      const s = this.stateAt(p, t);
      if (!s || !s.alive) {
        d.visible = false;
        const tr = this.tracers?.get(p.id);
        if (tr) tr.visible = false; // мёртвые не стреляют
        continue;
      }
      d.visible = true;
      d.position.set(s.x, s.y, s.z);
      d.rotation.z = (s.yaw * Math.PI) / 180;
      const crouch = s.duck * 18;
      d.userData.body.scale.set(1, 1 - s.duck * 0.3, 1);
      d.userData.body.position.z = 34 - crouch * 0.5;
      d.userData.head.position.z = 66 - crouch;
      d.userData.nose.position.z = 64 - crouch;
      d.userData.tag.position.z = 92 - crouch;
      d.userData.flash.position.z = 60 - crouch;
      if (p.id === this.me) pov = s;
      this.shotFx(p, s, d, t);
    }
    const me = this.dummies.get(this.me);
    if (me) me.userData.tag.visible = this.mode === "free"; // в облёте свой ник закрыл бы кадр
    const orbit = this.mode === "orbit" ? this.orbitAt(t) : null;
    if (orbit) {
      this.camera.position.set(orbit.x, orbit.y, orbit.z);
      this.camera.lookAt(this.camera.position.clone().add(dir(orbit.pitch, orbit.yaw)));
      this.setFov(orbit.fov);
      if (me) me.visible = !!pov;
    } else if ((this.mode === "pov" || this.mode === "orbit") && pov) {
      const eye = new THREE.Vector3(pov.x, pov.y, pov.z + 64 - 18 * pov.duck);
      this.camera.position.copy(eye);
      this.camera.lookAt(eye.clone().add(dir(pov.pitch, pov.yaw)));
      this.setFov(this.fov);
      if (me) me.visible = false; // своё тело в кадре не нужно
    } else if (this.mode === "free") {
      this.controls.update();
    }
    if (this.pathLine) this.pathLine.visible = this.mode === "free";
    const view = this.mode === "free" ? "free" : orbit ? "orbit" : pov ? "pov" : "none";
    if (view !== this.view) { this.view = view; this.canvas.parentElement.dataset.view = view; }
    this.updateWeapon(view === "pov" ? this.heldAt(t) : null, pov);
  }

  updateWeapon(name, pov) {
    if (name && !this.weapons.has(name)) this.loadWeapon(name);
    const obj = name ? this.weapons.get(name) : null;
    if (obj !== this.heldShown) {
      if (this.heldShown) this.vmScene.remove(this.heldShown);
      if (obj) this.vmScene.add(obj);
      this.heldShown = obj || null;
    }
    // отдача: прицел «подпрыгивает» (CSS-переменная --kick), оружие уходит назад и вверх
    const since = this.sinceShot(this.me, this.tick);
    const kick = since < 10 ? Math.pow(1 - since / 10, 2) : 0;
    if (Math.abs(kick - (this.kick || 0)) > 0.01) { this.kick = kick; this.canvas.parentElement.style.setProperty("--kick", kick.toFixed(3)); }
    if (!obj) return;
    if (obj.userData.flash) {
      const on = since < SHOT_TICKS;
      obj.userData.flash.visible = on;
      if (on) { const k = 1 - since / SHOT_TICKS; const sc = 0.08 + 0.09 * k; obj.userData.flash.scale.set(sc, sc, 1); obj.userData.flash.material.rotation = since * 1.3; }
    }
    // положение «как в руках»: справа снизу, ствол к центру экрана; лёгкое покачивание при ходьбе
    const knife = /knife|bayonet|karambit|daggers/i.test(name);
    const nade = /grenade|flashbang|molotov|decoy/i.test(name);
    const pos = knife ? [0.15, -0.16, -0.32] : nade ? [0.14, -0.15, -0.3] : [0.135, -0.155, -0.36];
    const sway = pov ? Math.sin(this.tick * 0.12) * 0.002 : 0;
    obj.position.set(pos[0] + sway, pos[1] + Math.abs(sway) + kick * 0.006, pos[2] + kick * 0.03);
    obj.rotation.set((knife ? 0.2 : 0.03) + kick * 0.09, knife ? 0.35 : 0.13, knife ? 0.25 : 0.04);
  }

  setFov(f) {
    const v = vfov(f);
    if (Math.abs(this.camera.fov - v) > 0.01) { this.camera.fov = v; this.camera.updateProjectionMatrix(); }
  }

  // для инфо-панели: fps (среднее за ~0.5 с), время кадра, нагрузка и состояние игрока клипа
  stats() {
    const r = this.renderer.info.render;
    const out = { fps: this.fps || 0, ms: this.frameMs || 0, tris: this.lastTris || r.triangles, calls: this.lastCalls || r.calls, view: this.view };
    if (!this.data) return out;
    const p = this.data.players.find((x) => x.id === this.me);
    const s = p && this.stateAt(p, this.tick);
    if (s) {
      const b = this.stateAt(p, this.tick - 8);
      out.hp = s.alive ? s.hp : 0;
      out.speed = b ? Math.round(Math.hypot(s.x - b.x, s.y - b.y) * (TICKRATE / 8)) : 0;
      out.pos = [Math.round(s.x), Math.round(s.y), Math.round(s.z)];
    }
    out.held = this.heldAt(this.tick);
    const alive = { 2: 0, 3: 0 };
    for (const q of this.data.players) { const st = this.stateAt(q, this.tick); if (st?.alive) alive[q.team]++; }
    out.alive = alive;
    return out;
  }

  loop() {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.lastFrame) {
      this.frames = (this.frames || 0) + 1;
      this.acc = (this.acc || 0) + (now - this.lastFrame);
      if (this.acc >= 500) { this.fps = Math.round((this.frames * 1000) / this.acc); this.frameMs = this.acc / this.frames; this.frames = 0; this.acc = 0; }
    }
    this.lastFrame = now;
    this.update();
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.heldShown) {
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCam);
    }
    this.lastTris = this.renderer.info.render.triangles;
    this.lastCalls = this.renderer.info.render.calls;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.vmScene.environment?.dispose();
    for (const w of this.weapons.values()) w?.traverse((o) => { o.geometry?.dispose(); if (o.material) { for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"]) o.material[k]?.dispose(); o.material.dispose(); } });
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      const m = o.material;
      if (m) { m.map?.dispose(); m.dispose(); }
    });
    this.renderer.dispose();
  }
}
