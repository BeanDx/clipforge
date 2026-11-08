// «Вырезать поиск»: в моменте на несколько киллов между ними бывает по полминуты беготни по карте.
// Такой клип делится на куски — от предыдущего килла остаётся AFTER секунд, до следующего BEFORE,
// середина выбрасывается. Каждый кусок пишется отдельной записью (у него свои верные тайминги
// для HUD, урона, slow-mo и повторов), а render.rs склеивает куски одной группы обратно в один клип.
const TICKRATE = 64;
export const GAP_DEFAULTS = { gap: 10, after: 3, before: 5, minCut: 3 };

const inRange = (t, a, b) => t >= a && t <= b;

export function splitGaps(clip, group, opts = {}) {
  const { gap, after, before, minCut } = { ...GAP_DEFAULTS, ...opts };
  const raw = clip.rawTicks || clip.killTicks || [];
  // пары тик–жертва в порядке времени (victims идут парой к rawTicks)
  const pairs = raw.map((t, j) => [t, clip.victims?.[j]]).sort((a, b) => a[0] - b[0]);
  const cuts = [];
  for (let j = 1; j < pairs.length; j++) {
    const [a, b] = [pairs[j - 1][0], pairs[j][0]];
    if (b - a <= gap * TICKRATE) continue;
    const from = a + after * TICKRATE, to = b - before * TICKRATE;
    if (to - from >= minCut * TICKRATE) cuts.push([from, to]);
  }
  if (!cuts.length) return [clip];
  const bounds = [];
  let s = clip.start;
  for (const [from, to] of cuts) { bounds.push([s, from]); s = to; }
  bounds.push([s, clip.end]);
  return bounds.map(([start, end], part) => {
    const mine = pairs.filter(([t]) => inRange(t, start, end));
    return {
      ...clip, start, end, group, part, parts: bounds.length,
      kills: mine.length,
      killTicks: mine.map(([t]) => t),
      rawTicks: mine.map(([t]) => t),
      victims: mine.map(([, v]) => v),
      hsTicks: (clip.hsTicks || []).filter((t) => inRange(t, start, end)),
      ...(clip.boxTicks ? { boxTicks: clip.boxTicks.filter((t) => inRange(t, start, end)) } : {}),
    };
  });
}
