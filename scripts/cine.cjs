// Данные для кинокамеры на фраге: положение игрока вокруг тика килла и сдвиг игрового времени.
// argv: <demo> <steamid> <JSON [killTick, ...]>
// stdout: JSON [{ offset, yaw, pts: [[tick, x, y, z], ...] }, ...] — по одному на килл
// offset: game_time = tick / 64 + offset (время для mirv_campath в HLAE — игровое)
const { parseTicks } = require("@laihoe/demoparser2");

try {
  const [file, steamid, killsJson] = process.argv.slice(2);
  const out = JSON.parse(killsJson).map((k) => {
    const ticks = [];
    for (let t = k - 16; t <= k + 220; t += 4) ticks.push(t);
    const rows = parseTicks(file, ["X", "Y", "Z", "yaw", "game_time"], ticks, [steamid])
      .filter((r) => String(r.steamid) === String(steamid) && r.X != null)
      .sort((a, b) => a.tick - b.tick);
    if (!rows.length) return null;
    // game_time бывает округлён — берём сдвиг на тике, кратном 64, и выравниваем до тика
    const ref = rows.find((r) => r.tick % 64 === 0) || rows[0];
    const offset = Math.round((ref.game_time - ref.tick / 64) * 64) / 64;
    const atKill = rows.reduce((b, r) => (Math.abs(r.tick - k) < Math.abs(b.tick - k) ? r : b), rows[0]);
    return { offset, yaw: atKill.yaw, pts: rows.map((r) => [r.tick, r.X, r.Y, r.Z]) };
  });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
