// 3D-кузница в герое: логотип clipforge объёмом (жёлтая рамка-куб и светящееся бирюзовое ядро),
// вокруг вращается кольцо экранов со скриншотами приложения, из ядра летят искры.
// Мышь наклоняет сцену, прокрутка отводит камеру. Вне экрана и в фоновой вкладке рендер стоит.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const YELLOW = 0xf5c518, TEAL = 0x2ee6c0;
const SHOTS = ["demo", "moments", "studio-effects", "gallery", "studio-sound", "overlay", "studio-camera", "settings", "card"];

export function startScene(canvas, { lang = "ru" } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = innerWidth < 760;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07090d, 0.045);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

  // всё, что двигается вместе, — в одной группе; справа от текста на десктопе, по центру сверху на телефоне
  const rig = new THREE.Group();
  scene.add(rig);

  scene.add(new THREE.AmbientLight(0x8899aa, 0.5));
  const key = new THREE.PointLight(TEAL, 40, 20); key.position.set(0, 0, 0); rig.add(key);
  const rim = new THREE.DirectionalLight(YELLOW, 1.6); rim.position.set(-4, 5, 3); scene.add(rim);

  // --- логотип: рамка из 12 брусков ---
  const logo = new THREE.Group();
  rig.add(logo);
  const S = 1.5, T = 0.16;
  const frameMat = new THREE.MeshStandardMaterial({ color: YELLOW, emissive: YELLOW, emissiveIntensity: 0.55, metalness: 0.6, roughness: 0.3 });
  const edge = (sx, sy, sz, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frameMat); m.position.set(x, y, z); logo.add(m); };
  for (const a of [-S, S]) for (const b of [-S, S]) {
    edge(2 * S + T, T, T, 0, a, b);
    edge(T, 2 * S + T, T, a, 0, b);
    edge(T, T, 2 * S + T, a, b, 0);
  }
  // ядро
  const core = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 1.05), new THREE.MeshStandardMaterial({ color: TEAL, emissive: TEAL, emissiveIntensity: 2.2, roughness: 0.2 }));
  logo.add(core);
  const shell = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshBasicMaterial({ color: TEAL, wireframe: true, transparent: true, opacity: 0.18 }));
  logo.add(shell);

  // --- кольцо экранов ---
  const ring = new THREE.Group();
  rig.add(ring);
  const loader = new THREE.TextureLoader();
  const R = 5.4, W = 2.6, H = W * 0.62;
  const panels = SHOTS.map((name, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, side: THREE.DoubleSide, fog: true });
    const g = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W * 1.03, H * 1.05)), new THREE.LineBasicMaterial({ color: i % 3 === 0 ? YELLOW : 0x2c3a4b }));
    g.add(plane, border);
    const a = (i / SHOTS.length) * Math.PI * 2;
    g.position.set(Math.cos(a) * R, Math.sin(a * 2) * 0.35, Math.sin(a) * R);
    g.lookAt(0, g.position.y, 0);
    g.rotateY(Math.PI); // лицом наружу
    g.userData = { a, name, mat, bob: Math.random() * Math.PI * 2 };
    ring.add(g);
    return g;
  });
  ring.rotation.x = 0.22;
  ring.rotation.z = -0.08;

  const setLang = (l) => {
    for (const p of panels) {
      const name = p.userData.name;
      const file = `shots/${name}-${l}.webp`;
      loader.load(file, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        // карточка вертикальная — берём центр, остальные — верхнюю левую часть, где самое интересное
        const img = tex.image, k = (W / H) / (img.width / img.height);
        if (k < 1) { tex.repeat.set(k, 1); tex.offset.set((1 - k) / 2, 0); }
        else { tex.repeat.set(1, 1 / k); tex.offset.set(0, 1 - 1 / k); }
        const old = p.userData.mat.map;
        p.userData.mat.map = tex; p.userData.mat.needsUpdate = true;
        old?.dispose();
        if (reduce) composer.render(); // без анимации кадр перерисовывается только тут
      });
    }
  };
  setLang(lang);

  // --- искры ---
  const N = small ? 260 : 600;
  const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), col = new Float32Array(N * 3), life = new Float32Array(N);
  const cY = new THREE.Color(YELLOW), cT = new THREE.Color(TEAL);
  const spawn = (i, init) => {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.6;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = (Math.random() - 0.5) * 0.6; pos[i * 3 + 2] = Math.sin(a) * r;
    const sp = 0.6 + Math.random() * 1.8;
    vel[i * 3] = Math.cos(a) * sp * 0.8; vel[i * 3 + 1] = 1 + Math.random() * 2.2; vel[i * 3 + 2] = Math.sin(a) * sp * 0.8;
    life[i] = init ? Math.random() * 3 : 0;
    const c = Math.random() < 0.7 ? cY : cT;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  };
  for (let i = 0; i < N; i++) spawn(i, true);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const dotTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "#fff"); g.addColorStop(0.25, "rgba(255,255,255,.8)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.09, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  rig.add(sparks);

  // пол-сетка
  const grid = new THREE.GridHelper(60, 60, 0x1c2430, 0x141b24);
  grid.position.y = -3.4;
  grid.material.transparent = true; grid.material.opacity = 0.55;
  scene.add(grid);

  // --- постобработка: свечение ---
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), small ? 0.7 : 0.95, 0.55, 0.2);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const narrow = w < 760;
    // на узком десктопе сцена меньше и правее, чтобы не лезть на заголовок
    const k = narrow ? 0.62 : Math.min(1, Math.max(0.68, w / 1500));
    rig.position.set(narrow ? 0 : Math.min(5.6, 1.6 + w / 380), narrow ? 2.1 : 0.2, 0);
    rig.scale.setScalar(k);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ввод
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener("pointermove", (e) => { mouse.tx = e.clientX / innerWidth - 0.5; mouse.ty = e.clientY / innerHeight - 0.5; }, { passive: true });
  let scrollK = 0;
  addEventListener("scroll", () => { scrollK = Math.min(1, scrollY / innerHeight); }, { passive: true });
  // «удар» по ядру при клике по кнопке скачивания и т. п.
  let punch = 0;
  const hit = () => { punch = 1; };

  let visible = true, running = false, last = performance.now(), t = 0;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }).observe(canvas);
  document.addEventListener("visibilitychange", kick);

  function frame(now) {
    running = false;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    mouse.x += (mouse.tx - mouse.x) * 0.05; mouse.y += (mouse.ty - mouse.y) * 0.05;

    logo.rotation.x = t * 0.35 + mouse.y * 0.6;
    logo.rotation.y = t * 0.5 + mouse.x * 0.8;
    core.rotation.set(-t * 0.9, -t * 1.2, 0);
    shell.rotation.set(t * 0.4, -t * 0.3, t * 0.2);
    punch *= 0.92;
    const pulse = 1 + Math.sin(t * 2.4) * 0.05 + punch * 0.4;
    core.scale.setScalar(pulse);
    core.material.emissiveIntensity = 2.2 + punch * 3;
    key.intensity = 40 + Math.sin(t * 2.4) * 8 + punch * 60;

    ring.rotation.y = t * 0.12 + mouse.x * 0.3 + scrollK * 1.2;
    for (const p of panels) {
      p.position.y = Math.sin(p.userData.a * 2) * 0.35 + Math.sin(t * 0.9 + p.userData.bob) * 0.12;
    }

    for (let i = 0; i < N; i++) {
      life[i] += dt;
      if (life[i] > 3.2) { spawn(i, false); continue; }
      vel[i * 3 + 1] -= 0.9 * dt;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    }
    sparkGeo.attributes.position.needsUpdate = true;

    camera.position.set(mouse.x * 1.4, 1.2 - mouse.y * 0.8 + scrollK * 1.5, 13 + scrollK * 6);
    camera.lookAt(rig.position.x * 0.55, rig.position.y * 0.6, 0);
    grid.position.z = (t * 0.6) % 1;

    composer.render();
    if (!reduce) kick();
  }
  function kick() {
    if (running || reduce && t > 0 || !visible || document.hidden) return;
    running = true;
    requestAnimationFrame(frame);
  }
  kick();

  return { setLang, hit };
}
