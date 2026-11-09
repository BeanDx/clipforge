// Выбор из нескольких демок: моменты, выбранные в демке, которую потом сменили, рендерятся вместе
// с выбранными в открытой — одним роликом, со всеми эффектами клипов (повторы, slow-mo, трек через
// все клипы). Каждый момент хранит всё, что нужно для рендера без своей демки в памяти:
// слот игрока, состав (слоты жертв для повтора и маски голосового чата) и попадания (цифры урона).
// Сами клипы пишутся за один запуск CS2: render.rs переходит к следующей демке сам (playdemo).
const KEY = "cf-reel";
const TICKRATE = 64;

export const loadReel = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((e) => e?.clip && e.demo) : [];
  } catch { return []; }
};
export const saveReel = (list) => {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* без localStorage — только на сессию */ }
};

export const reelKey = (demo, steamid, round) => `${demo}|${steamid}|${round}`;

export function reelEntry({ clip, demo, title, map, player, slot, roster, hurts }) {
  const vs = new Set(clip.victims || []);
  // с запасом: «обрезать» в настройках может чуть раздвинуть клип
  const lo = clip.start - 10 * TICKRATE, hi = clip.end + 10 * TICKRATE;
  return {
    key: reelKey(demo, clip.steamid, clip.round),
    demo, title, map: map || "", player: player || clip.name || "", slot: Number(slot),
    roster: roster.filter((p) => p.slot).map(({ id, slot, team }) => ({ id, slot, team })),
    hurts: hurts.filter((h) => h.steamid === clip.steamid && vs.has(h.victim) && h.tick >= lo && h.tick <= hi),
    clip, addedAt: Date.now(),
  };
}

// голосовой чат клипа подборки — маска по составу его демки (как voiceMasks в HighlightRenderer)
export function entryVoice(e, mode) {
  if (mode === "none") return [0, 0];
  if (mode !== "team" && mode !== "enemy") return [-1, -1];
  const self = e.roster.find((p) => p.id === e.clip.steamid);
  const mine = e.roster.filter((p) => (p.team === self?.team) === (mode === "team"));
  return [mine.reduce((m, p) => m | (1 << (p.slot - 1)), 0), 0];
}

