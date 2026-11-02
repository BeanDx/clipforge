// Углы обзора игрока (куда смотрит камера) на каждом тике клипов — для текста песни «в мире».
// argv: <demo> <steamid> <JSON [[start,end], ...]> [<JSON [[[victim, killTick], ...], ...]>]
// stdout: JSON [[[tick, pitch, yaw], ...], ...]
// С четвёртым аргументом (рамка на цели, пресет Night) — по клипу объект
// { cam, eye: [[tick, x, y, z]], targets: [{ kill, pts: [[tick, x, y, z]] }] }: глаз игрока и жертвы перед киллом
const { parseTicks } = require("@laihoe/demoparser2");

try {
  const [file, steamid, rangesJson, victimsJson] = process.argv.slice(2);
  const ranges = JSON.parse(rangesJson);
  const victims = victimsJson ? JSON.parse(victimsJson) : null;
  const out = ranges.map(([start, end], ri) => {
    const ticks = [];
    for (let t = start; t <= end; t++) ticks.push(t);
    const rows = parseTicks(file, victims ? ["pitch", "yaw", "X", "Y", "Z", "duck_amount"] : ["pitch", "yaw"], ticks, [steamid])
      .filter((r) => String(r.steamid) === String(steamid) && r.pitch != null && r.yaw != null)
      .sort((a, b) => a.tick - b.tick);
    const cam = rows.map((r) => [r.tick, +r.pitch.toFixed(3), +r.yaw.toFixed(3)]);
    if (!victims) return cam;
    // глаз: 64 юнита над ногами стоя, 46 — присев
    const eye = rows.filter((r) => r.X != null).map((r) => [r.tick, +r.X.toFixed(1), +r.Y.toFixed(1), +(r.Z + 64 - 18 * (r.duck_amount || 0)).toFixed(1)]);
    const targets = (victims[ri] || []).map(([vid, kill]) => {
      const vt = [];
      for (let t = kill - 80; t <= kill; t += 2) vt.push(t);
      const pts = parseTicks(file, ["X", "Y", "Z"], vt, [vid])
        .filter((r) => String(r.steamid) === String(vid) && r.X != null)
        .sort((a, b) => a.tick - b.tick)
        .map((r) => [r.tick, +r.X.toFixed(1), +r.Y.toFixed(1), +r.Z.toFixed(1)]);
      return { kill, pts };
    }).filter((t) => t.pts.length);
    return { cam, eye, targets };
  });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
