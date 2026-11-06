// Песочница «текст песни в 3D»: маленькая «карта» (песчаные стены, ящики, туман, тёплый свет)
// и строчка пользователя, которая встаёт в пространстве слово за словом, как в клипах clipforge.
// Стили — упрощённые версии из приложения: акцент (одно слово крупно и цветом), неон, чистый.
import * as THREE from "three";

const FONT = '800 120px "Unbounded", "Segoe UI", sans-serif';

export function startLyrics(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1610);
  scene.fog = new THREE.Fog(0x2a2318, 9, 34);
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100);

  // --- «карта»: коридор из песчаника ---
  const sand = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), sand(0x8c7553));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const box = (w, h, d, x, y, z, c = 0xb39a72) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), sand(c));
    m.position.set(x, y + h / 2, z); m.castShadow = m.receiveShadow = true; scene.add(m); return m;
  };
  box(1.2, 7, 40, -7, 0, -6); // стена слева
  box(1.2, 6, 26, 7.5, 0, -12); // стена справа
  box(16, 8, 1.2, 0, 0, -24, 0xa48c66); // дальняя стена
  box(3.4, 2.2, 1.2, -3.5, 5, -23.2, 0x5d4c36); // проём
  box(1.6, 1.6, 1.6, 4.4, 0, -4, 0x7a5a32); // ящики
  box(1.6, 1.6, 1.6, 4.4, 1.6, -4.2, 0x6e5230);
  box(1.6, 1.6, 1.6, 5.9, 0, -5.6, 0x7a5a32);
  box(2.2, 1, 1.4, -4.5, 0, -10, 0x6f6a5e);
  scene.add(new THREE.HemisphereLight(0xffe2b0, 0x3a2c1c, 0.9));
  const sun = new THREE.DirectionalLight(0xffd59a, 2.2);
  sun.position.set(-8, 14, 6); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20 });
  scene.add(sun);

  // --- слова ---
  const words = new THREE.Group();
  scene.add(words);
  let style = "accent", items = [], t0 = 0;

  function wordTex(text, { color, glow, stroke }) {
    const c = document.createElement("canvas"), x = c.getContext("2d");
    x.font = FONT;
    const w = Math.ceil(x.measureText(text).width) + 80, h = 190;
    c.width = w; c.height = h;
    x.font = FONT; x.textBaseline = "middle"; x.textAlign = "center";
    if (glow) { x.shadowColor = glow; x.shadowBlur = 36; }
    if (stroke) { x.lineWidth = 10; x.strokeStyle = stroke; x.strokeText(text, w / 2, h / 2 + 6); }
    x.fillStyle = color; x.fillText(text, w / 2, h / 2 + 6);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, aspect: w / h };
  }

  function look(i, n, s) {
    const accent = i === n - 1 || (n > 3 && i === Math.floor(n / 2));
    if (s === "neon") return { color: "#ffffff", glow: i % 2 ? "#2ee6c0" : "#ff3df2", big: accent };
    if (s === "clean") return { color: "#ffffff", glow: "rgba(0,0,0,.6)", big: false };
    return accent ? { color: "#ff2f6d", glow: "rgba(255,47,109,.7)", stroke: "#2a0010", big: true } : { color: "#ffffff", glow: "rgba(255,255,255,.55)", big: false };
  }

  function setLine(text, s = style) {
    style = s;
    for (const m of items) { m.material.map.dispose(); m.material.dispose(); m.geometry.dispose(); }
    words.clear(); items = [];
    const list = String(text || "").trim().toUpperCase().split(/\s+/).filter(Boolean).slice(0, 9);
    // раскладка: строки по ~3 слова, крупное слово — отдельной строкой
    const rows = []; let row = [];
    list.forEach((w, i) => {
      const L = look(i, list.length, s);
      if (L.big && row.length) { rows.push(row); row = []; }
      row.push({ w, i, L });
      if (L.big || row.length >= 3) { rows.push(row); row = []; }
    });
    if (row.length) rows.push(row);
    const lineH = 0.95;
    rows.forEach((r, ri) => {
      const parts = r.map(({ w, i, L }) => {
        const { tex, aspect } = wordTex(w, L);
        const h = L.big ? 1.45 : 0.8;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(h * aspect, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
        m.userData = { i, h, w: h * aspect };
        return m;
      });
      const total = parts.reduce((a, m) => a + m.userData.w, 0) - 0.15 * (parts.length - 1);
      let x = -total / 2;
      const y = 3.6 - ri * (lineH + (r.some((p) => p.L.big) ? 0.55 : 0));
      parts.forEach((m) => {
        m.position.set(x + m.userData.w / 2, y, -6);
        m.userData.base = m.position.clone();
        x += m.userData.w - 0.15;
        words.add(m); items.push(m);
      });
    });
    words.rotation.y = 0.22;
    t0 = performance.now();
  }

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 1.4 ? 62 : 50;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let visible = false, raf = 0;
  function frame(now) {
    raf = 0;
    const t = (now - t0) / 1000;
    const cycle = 2 + items.length * 0.32; // показ + пауза, потом заново
    const tc = reduce ? 99 : t % (cycle + 1.2);
    for (const m of items) {
      const k = Math.max(0, Math.min(1, (tc - 0.3 - m.userData.i * 0.32) / 0.35));
      const e = 1 - Math.pow(1 - k, 3), out = tc > cycle ? Math.max(0, 1 - (tc - cycle) / 0.6) : 1;
      m.material.opacity = e * out;
      const pop = 1 + (1 - e) * 0.6 + (k > 0 && k < 1 ? 0.06 : 0);
      m.scale.setScalar(pop);
      m.position.y = m.userData.base.y + (1 - e) * 0.5 + Math.sin(now / 900 + m.userData.i) * 0.03;
      m.position.z = m.userData.base.z + (1 - e) * 1.2;
    }
    const s = now / 1000;
    camera.position.set(Math.sin(s * 0.25) * 0.8, 1.7 + Math.sin(s * 0.4) * 0.08, 4.2);
    camera.lookAt(0.6, 2.4, -8);
    renderer.render(scene, camera);
    if (visible && !reduce) raf = requestAnimationFrame(frame);
  }
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  }).observe(canvas);

  return {
    play(text, s) { setLine(text, s); if (!raf) raf = requestAnimationFrame(frame); },
  };
}
