// Расширенная статистика профиля: тип игрока и когда лучше играется, рекорды за последние 100 матчей
// и «приколы» — тильт после поражения, овертаймы, мультикиллы, клатчи.
import { tr } from "../../i18n";
import { mapName, mapTint } from "../match/dossier";
import { num, pad, mapId, gameTime } from "./data";

const DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const PARTS = [
  { id: "night", name: "ночью", from: 0, to: 6, icon: "🌙" },
  { id: "morning", name: "утром", from: 6, to: 12, icon: "🌅" },
  { id: "day", name: "днём", from: 12, to: 18, icon: "☀️" },
  { id: "evening", name: "вечером", from: 18, to: 24, icon: "🌆" },
];

// один матч FACEIT → числа
function row(g) {
  const k = num(g.Kills) || 0, d = num(g.Deaths) || 0;
  const sc = String(g.Score || "").split("/").map((x) => num(x)).filter((x) => x != null);
  const rounds = num(g.Rounds) || (sc.length === 2 ? sc[0] + sc[1] : null);
  return {
    g, id: g["Match Id"], t: gameTime(g), map: mapId(g.Map), win: g.Result === "1",
    k, d, a: num(g.Assists) || 0, kd: num(g["K/D Ratio"]) ?? k / Math.max(1, d),
    adr: num(g.ADR), hs: num(g["Headshots %"]), mvp: num(g.MVPs) || 0,
    k3: num(g["Triple Kills"]) || 0, k4: num(g["Quadro Kills"]) || 0, k5: num(g["Penta Kills"]) || 0,
    sniper: num(g["Sniper Kills"]), clutch: (num(g["1v1Wins"]) || 0) + (num(g["1v2Wins"]) || 0),
    first: num(g["First Kills"]),
    rounds, diff: sc.length === 2 ? Math.abs(sc[0] - sc[1]) : null, score: String(g.Score || "").replace(/\s/g, ""),
  };
}

const maxBy = (arr, f) => arr.reduce((b, x) => (f(x) != null && (b == null || f(x) > f(b)) ? x : b), null);
const minBy = (arr, f) => maxBy(arr, (x) => (f(x) == null ? null : -f(x)));
const wr = (xs) => (xs.length ? Math.round((xs.filter((x) => x.win).length / xs.length) * 100) : null);

// самые длинные серии побед и поражений (rs — старые → новые)
function streaks(rs) {
  let w = 0, l = 0, cw = 0, cl = 0;
  rs.forEach((r) => { if (r.win) { cw++; cl = 0; } else { cl++; cw = 0; } w = Math.max(w, cw); l = Math.max(l, cl); });
  return { w, l };
}

// тип игрока по средним цифрам — для смеха, но по делу
function archetype(av) {
  if (av.sniper != null && av.sniper >= 0.35) return { icon: "🔭", name: "AWP-шник", why: tr("{0}% киллов со снайперки", Math.round(av.sniper * 100)) };
  if (av.hs >= 58) return { icon: "🎯", name: "Хэдшот-машина", why: tr("{0}% в голову", Math.round(av.hs)) };
  if (av.kd >= 1.35 && av.adr >= 90) return { icon: "👑", name: "Тащер", why: tr("K/D {0} и {1} ADR", av.kd.toFixed(2), Math.round(av.adr)) };
  if (av.adr >= 88) return { icon: "💥", name: "Дамагер", why: tr("{0} урона за раунд", Math.round(av.adr)) };
  if (av.kd >= 1.2) return { icon: "🔪", name: "Фраггер", why: tr("K/D {0}", av.kd.toFixed(2)) };
  if (av.a >= 6) return { icon: "🤝", name: "Командный игрок", why: tr("{0} ассистов за матч", av.a.toFixed(1)) };
  if (av.kd < 0.85) return { icon: "🛡", name: "Мясной щит", why: tr("принимает пули на себя: K/D {0}", av.kd.toFixed(2)) };
  return { icon: "🪖", name: "Солдат", why: tr("стабильный K/D {0}", av.kd.toFixed(2)) };
}

const when = (t) => { const d = t ? new Date(t) : null; return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}` : ""; };

// part: "top" — тип игрока, "bottom" — рекорды и приколы (на всю ширину)
export function Records({ fc, onOpenMatch, part }) {
  const raw = fc?.more?.length ? fc.more : fc?.games || [];
  const rs = raw.map(row).sort((a, b) => a.t - b.t);
  if (!rs.length) return null;
  const n = rs.length;
  const sum = rs.reduce((s, r) => ({ k: s.k + r.k, d: s.d + r.d, a: s.a + r.a, adr: s.adr + (r.adr || 0), hs: s.hs + (r.hs || 0), mvp: s.mvp + r.mvp,
    k3: s.k3 + r.k3, k4: s.k4 + r.k4, k5: s.k5 + r.k5, sn: s.sn + (r.sniper || 0), cl: s.cl + r.clutch, fk: s.fk + (r.first || 0) }),
  { k: 0, d: 0, a: 0, adr: 0, hs: 0, mvp: 0, k3: 0, k4: 0, k5: 0, sn: 0, cl: 0, fk: 0 });
  const hasSniper = rs.some((r) => r.sniper != null);
  const av = { kd: sum.k / Math.max(1, sum.d), adr: sum.adr / n, hs: sum.hs / n, a: sum.a / n, sniper: hasSniper ? sum.sn / Math.max(1, sum.k) : null };
  const type = archetype(av);

  // рекорды
  const rec = [
    { icon: "🔪", label: tr("больше всего киллов"), r: maxBy(rs, (r) => r.k), v: (r) => `${r.k}` },
    { icon: "⚖️", label: tr("лучший K/D"), r: maxBy(rs, (r) => r.kd), v: (r) => r.kd.toFixed(2) },
    { icon: "💥", label: tr("больше всего урона"), r: maxBy(rs, (r) => r.adr), v: (r) => `${Math.round(r.adr)} ADR` },
    { icon: "⭐", label: tr("больше всего MVP"), r: maxBy(rs, (r) => r.mvp || null), v: (r) => `${r.mvp} MVP` },
    { icon: "🚂", label: tr("самый разгром"), r: maxBy(rs.filter((r) => r.win), (r) => r.diff), v: (r) => r.score },
    { icon: "😤", label: tr("тащил, но слили"), r: maxBy(rs.filter((r) => !r.win), (r) => r.kd), v: (r) => `K/D ${r.kd.toFixed(2)}` },
    { icon: "💀", label: tr("матч, который лучше забыть"), r: minBy(rs, (r) => r.kd), v: (r) => `${r.k}-${r.d}`, bad: true },
  ].filter((x) => x.r);

  // когда играется лучше
  const parts = PARTS.map((p) => {
    const xs = rs.filter((r) => r.t && new Date(r.t).getHours() >= p.from && new Date(r.t).getHours() < p.to);
    return { ...p, n: xs.length, wr: wr(xs), kd: xs.length ? xs.reduce((s, r) => s + r.k, 0) / Math.max(1, xs.reduce((s, r) => s + r.d, 0)) : null };
  });
  const bestPart = maxBy(parts.filter((p) => p.n >= 5), (p) => p.wr);
  const days = DAYS.map((name, i) => { const xs = rs.filter((r) => r.t && new Date(r.t).getDay() === i); return { name, n: xs.length, wr: wr(xs) }; });
  const bestDay = maxBy(days.filter((d) => d.n >= 4), (d) => d.wr);

  // тильт: как играется сразу после поражения и после победы
  const afterL = rs.slice(1).filter((_, i) => !rs[i].win), afterW = rs.slice(1).filter((_, i) => rs[i].win);
  const tilt = afterL.length >= 4 && afterW.length >= 4 ? { l: wr(afterL), w: wr(afterW) } : null;
  const st = streaks(rs);
  const ot = rs.filter((r) => r.rounds > 24);
  const close = rs.filter((r) => r.diff != null && r.diff <= 2);
  const favMap = Object.entries(rs.reduce((m, r) => ({ ...m, [r.map]: (m[r.map] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];

  const facts = [
    { icon: "🧨", text: tr("трипл-киллов: {0} · квадро: {1} · эйсов: {2}", sum.k3, sum.k4, sum.k5) },
    { icon: "🪦", text: tr("киллов: {0} — команда соперника вынесена {1} раз", sum.k, Math.floor(sum.k / 5)) },
    { icon: "🔥", text: tr("рекорд серий: побед подряд — {0}, поражений подряд — {1}", st.w, st.l) },
    tilt && { icon: tilt.l + 8 < tilt.w ? "🧂" : "🧊", text: tilt.l + 8 < tilt.w
      ? tr("после поражения винрейт падает до {0}% (после победы — {1}%). Тильт есть", tilt.l, tilt.w)
      : tr("после поражения винрейт {0}%, после победы {1}% — железные нервы", tilt.l, tilt.w) },
    ot.length > 0 && { icon: "⏱", text: tr("овертаймов: {0}, выиграно {1}%", ot.length, wr(ot)) },
    close.length >= 3 && { icon: "🫣", text: tr("матчей, решённых в 1-2 раунда: {0}, побед в них {1}%", close.length, wr(close)) },
    sum.cl > 0 && { icon: "🧠", text: tr("выиграно клатчей 1v1 и 1v2: {0}", sum.cl) },
    sum.fk > 0 && { icon: "🚪", text: tr("первых киллов в раунде: {0} — по {1} за матч", sum.fk, (sum.fk / n).toFixed(1)) },
    favMap && { icon: "🗺", text: tr("чаще всего попадается {0} — {1} из {2} матчей", mapName(favMap[0]), favMap[1], n) },
    bestDay && { icon: "📅", text: tr("лучший день недели — {0}: {1}% побед", tr(bestDay.name), bestDay.wr) },
    { icon: "🏅", text: tr("MVP: {0} — по {1} за матч", sum.mvp, (sum.mvp / n).toFixed(1)) },
  ].filter(Boolean);

  if (part === "top") return (
    <>
      <section className="pf-card pf-type">
        <header className="pf-card__head"><h2>{tr("Кто ты в CS")}</h2><span className="mono dim">{tr("по {0} матчам", n)}</span></header>
        <div className="pf-type__main">
          <span className="pf-type__icon" aria-hidden="true">{type.icon}</span>
          <div><b>{tr(type.name)}</b><span className="dim">{type.why}</span></div>
        </div>
        <div className="pf-parts">
          {parts.map((p) => (
            <div key={p.id} className={`pf-part ${bestPart?.id === p.id ? "is-best" : ""}`} title={p.n ? tr("{0} матчей, K/D {1}", p.n, p.kd.toFixed(2)) : ""}>
              <span className="pf-part__bar"><i style={{ height: `${p.wr ?? 0}%` }} /></span>
              <b className="mono">{p.wr != null ? `${p.wr}%` : "—"}</b>
              <span>{p.icon} {tr(p.name)}</span>
            </div>
          ))}
        </div>
        <p className="pf-type__note dim">{bestPart ? tr("лучше всего играешь {0}", tr(bestPart.name)) : tr("мало матчей, чтобы понять, когда играется лучше")}</p>
      </section>
    </>
  );

  return (
    <>

      <section className="pf-card pf-rec span-2">
        <header className="pf-card__head"><h2>{tr("Рекорды")}</h2><span className="mono dim">{tr("за последние {0} матчей", n)}</span></header>
        <div className="pf-rec__grid">
          {rec.map((x, i) => (
            <button type="button" key={x.label} className={`pf-rec__item ${x.bad ? "is-bad" : ""}`} style={{ "--i": i, "--tint": mapTint(x.r.map) }}
              onClick={() => x.r.id && onOpenMatch(x.r.id)} title={tr("открыть матч на FACEIT")}>
              <span className="pf-rec__icon" aria-hidden="true">{x.icon}</span>
              <span className="pf-rec__label mono">{x.label}</span>
              <b className="pf-rec__value">{x.v(x.r)}</b>
              <span className="pf-rec__meta mono dim">{mapName(x.r.map)} · {x.r.win ? "W" : "L"} {x.r.score} · {when(x.r.t)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="pf-card pf-fun span-2">
        <header className="pf-card__head"><h2>{tr("Приколы")}</h2><span className="mono dim">{tr("факты из последних {0} матчей", n)}</span></header>
        <ul className="pf-fun__list">
          {facts.map((f, i) => <li key={i} style={{ "--i": i }}><span aria-hidden="true">{f.icon}</span>{f.text}</li>)}
        </ul>
      </section>
    </>
  );
}
