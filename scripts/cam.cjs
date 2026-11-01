// Углы обзора игрока (куда смотрит камера) на каждом тике клипов — для текста песни «в мире».
// argv: <demo> <steamid> <JSON [[start,end], ...]>  →  stdout: JSON [[[tick, pitch, yaw], ...], ...]
const { parseTicks } = require("@laihoe/demoparser2");

try {
  const [file, steamid, rangesJson] = process.argv.slice(2);
  const ranges = JSON.parse(rangesJson);
  const out = ranges.map(([start, end]) => {
    const ticks = [];
    for (let t = start; t <= end; t++) ticks.push(t);
    return parseTicks(file, ["pitch", "yaw"], ticks, [steamid])
      .filter((r) => String(r.steamid) === String(steamid) && r.pitch != null && r.yaw != null)
      .sort((a, b) => a.tick - b.tick)
      .map((r) => [r.tick, +r.pitch.toFixed(3), +r.yaw.toFixed(3)]);
  });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
