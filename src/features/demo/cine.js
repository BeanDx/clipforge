// Кинокамера на последнем фраге клипа:
//  • «вид убитого» — перед киллом камера смотрит глазами жертвы (spec_player, см. render.rs);
//  • «облёт» — после килла камера HLAE (mirv_campath) плавно облетает игрока.
// Положение игрока и сдвиг игрового времени — из scripts/cine.cjs.

const TICKRATE = 64;
const STEP = 6; // точка пути примерно каждые 0.1 с — дальше HLAE сглаживает кривой
const smooth = (x) => x * x * (3 - 2 * x);

// Положение игрока на тике (линейно между замерами каждые 4 тика)
function posAt(pts, tick) {
  if (tick <= pts[0][0]) return pts[0].slice(1);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] >= tick) {
      const [a, b] = [pts[i - 1], pts[i]];
      const f = (tick - a[0]) / (b[0] - a[0] || 1);
      return [1, 2, 3].map((j) => a[j] + (b[j] - a[j]) * f);
    }
  }
  return pts[pts.length - 1].slice(1);
}

// XML пути камеры для облёта после килла. Формат HLAE: координаты Quake (x вперёд, y влево,
// z вверх), углы в градусах: rx — крен, ry — наклон (вниз положительный), rz — поворот.
// Возвращает { xml, end } или null, если до конца клипа слишком мало времени.
export function orbitPath(data, kill, clipEnd, fov = 90) {
  if (!data?.pts?.length) return null;
  const start = kill + 6;
  const end = Math.min(start + Math.round(2.4 * TICKRATE), clipEnd - 4);
  if (end - start < TICKRATE * 0.8) return null;
  // начинаем за плечом игрока (видно то же, что видел он) и уходим по дуге в сторону
  return arcPath(data, start, end, fov, { a0: data.yaw + 200, a1: data.yaw + 80, r0: 85, dr: 45, h0: 18, dh: 16 });
}

// «Реакция после раунда»: с конца клипа камера уходит в третье лицо — медленно, шире и выше обычного
// облёта, чтобы игрок был в кадре всё время, пока в голосовом чате реагируют. { xml, start, end } или null.
export function tailPath(data, from, to, fov = 90) {
  if (!data?.pts?.length || to - from < TICKRATE) return null;
  const start = from, end = to - 4;
  return { ...arcPath(data, start, end, fov, { a0: data.yaw + 180, a1: data.yaw + 60, r0: 110, dr: 60, h0: 30, dh: 30 }), start };
}

function arcPath(data, start, end, fov, { a0, a1, r0, dr, h0, dh }) {
  let pts = "";
  for (let t = start; t <= end + STEP; t += STEP) {
    const tick = Math.min(t, end);
    const u = smooth((tick - start) / (end - start));
    const [px, py, pz] = posAt(data.pts, tick);
    const tz = pz + 52; // смотрим в район груди-головы
    const a = ((a0 + (a1 - a0) * u) * Math.PI) / 180;
    const r = r0 + dr * u, h = h0 + dh * u;
    const cx = px + r * Math.cos(a), cy = py + r * Math.sin(a), cz = tz + h;
    const yaw = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
    const pitch = (Math.atan2(cz - tz, r) * 180) / Math.PI;
    const time = data.offset + tick / TICKRATE;
    pts += `<p t="${time.toFixed(5)}" x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" z="${cz.toFixed(2)}" fov="${fov}" rx="0" ry="${pitch.toFixed(3)}" rz="${yaw.toFixed(3)}"/>\n`;
    if (tick === end) break;
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<campath>\n<points>\n${pts}</points>\n</campath>\n`;
  return { xml, end };
}
