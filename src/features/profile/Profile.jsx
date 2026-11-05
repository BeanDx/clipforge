// Вкладка «Профиль»: профиль CS2 игрока — Steam (src-tauri/src/profile.rs, без ключа), FACEIT (уровень,
// эло, винрейт, форма за 30 матчей, карты; нужен ключ Data API) и для своего профиля — то, что записал
// clipforge во время игры (gsi.rs): часы, матчи, оружие. Можно открыть любого игрока по SteamID или нику.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tr, trError, useLang } from "../../i18n";
import { mapName, mapTint } from "../match/dossier";
import "./profile.css";

// уровни FACEIT CS2: нижняя граница эло каждого уровня
const LEVELS = [0, 100, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
const LVL_COLOR = (l) => (l >= 10 ? "#fe1f00" : l >= 8 ? "#ff6309" : l >= 4 ? "#ffc800" : l >= 2 ? "#1ce400" : "#eeeeee");
const WEAPON = (w) => ({ ssg08: "SSG 08", awp: "AWP", ak47: "AK-47", m4a1_silencer: "M4A1-S", m4a1: "M4A4", deagle: "Desert Eagle", usp_silencer: "USP-S", glock: "Glock-18" }[w] || (w || "").replace(/_/g, " ").toUpperCase());
const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const pad = (n) => String(n).padStart(2, "0");
// карта FACEIT («Dust2», «de_dust2») → внутреннее имя для mapName/mapTint
const mapId = (m) => { const s = String(m || "").toLowerCase().replace(/\s+/g, ""); return s.includes("_") ? s : `de_${s}`; };
const gameTime = (g) => num(g["Match Finished At"]) || Date.parse(g["Created At"] || "") || 0;
const steamLike = (q) => /^7656\d{13}$/.test(q) || /steamcommunity\.com/i.test(q);
// подсказка в поле поиска: как будет понят ввод
const kindOf = (q, hasKey) => (/^7656\d{13}$/.test(q) ? "SteamID64" : /steamcommunity\.com/i.test(q) ? "Steam" : /faceit\.com/i.test(q) ? "FACEIT"
  : hasKey ? tr("ник") : tr("имя Steam"));

// кэш на время работы программы: вкладку переключают туда-сюда, а FACEIT считает запросы
const CACHE = new Map();
const TTL = 5 * 60_000;

// число, которое «докручивается» до значения при появлении
function Count({ to, digits = 0, suffix = "" }) {
  const [v, setV] = useState(0);
  const ref = useRef(0);
  useEffect(() => {
    if (to == null) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = ref.current, t0 = performance.now(), dur = reduce ? 0 : 900;
    let raf;
    const step = (t) => {
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      const x = from + (to - from) * (1 - Math.pow(1 - k, 3));
      ref.current = x; setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  if (to == null) return <>—</>;
  return <>{v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, " ")}{suffix}</>;
}

export function Profile({ faceitKey, onGoSettings }) {
  useLang();
  const key = (faceitKey || "").trim();
  const hasKey = key.length >= 32;
  const [me, setMe] = useState(null); // { steamid, total, two_weeks } — свой аккаунт
  const [home, setHome] = useState(null); // история из игры
  const [q, setQ] = useState("");
  const [data, setData] = useState(null); // { steam, fc, own }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    invoke("steam_playtime").then(setMe).catch(() => setMe({}));
    invoke("gsi_home").then(setHome).catch(() => {});
  }, []);

  const load = async (query) => {
    const ownId = me?.steamid;
    const qs = (query || "").trim() || ownId;
    if (!qs) return;
    const ck = `${qs}|${hasKey}`;
    const hit = CACHE.get(ck);
    if (hit && Date.now() - hit.at < TTL) { setData(hit.data); setErr(""); return; }
    const id = ++req.current;
    setBusy(true); setErr("");
    try {
      let steam = null, fc = null, steamErr = null;
      // Steam может не ответить (429 — слишком много запросов): тогда показываем хотя бы FACEIT
      const steamOf = (query) => invoke("steam_profile", { query }).catch((e) => { steamErr = e; return null; });
      const isFaceit = /faceit\.com/i.test(qs);
      if (isFaceit || (!steamLike(qs) && hasKey)) {
        // ник или ссылка FACEIT; если такого ника нет — пробуем как короткое имя Steam
        fc = await invoke("faceit_profile", { key, steamid: null, nickname: qs });
        const sid = fc?.player?.steamid;
        if (sid) steam = await steamOf(String(sid));
        else if (!isFaceit) steam = await steamOf(qs);
      } else {
        steam = await steamOf(qs);
      }
      const sid64 = steam?.steamid || (qs.match(/7656\d{13}/) || [])[0];
      if (!fc && sid64 && hasKey) fc = await invoke("faceit_profile", { key, steamid: sid64, nickname: null });
      if (!steam && !fc) throw steamErr || tr("игрок не найден");
      const res = { steam, fc, own: !!ownId && (steam?.steamid === ownId || fc?.player?.steamid === ownId), steamErr: steam ? null : steamErr };
      // если Steam не ответил — не запоминаем, чтобы следующий заход попробовал снова
      if (steam && !steam.stale) CACHE.set(ck, { at: Date.now(), data: res });
      if (id === req.current) setData(res);
    } catch (e) {
      if (id === req.current) setErr(trError(e));
    } finally {
      if (id === req.current) setBusy(false);
    }
  };
  // свой профиль — сразу, как только известен SteamID (и заново, если появился ключ FACEIT)
  useEffect(() => {
    if (!me?.steamid || q) return;
    const t = setTimeout(() => load(""), 0);
    return () => clearTimeout(t);
  }, [me?.steamid, hasKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = data?.steam, f = data?.fc, p = f?.player;
  const life = f?.lifetime || {};
  const games = [...(f?.games || [])].sort((a, b) => gameTime(a) - gameTime(b)); // старые → новые
  const name = p?.nickname || s?.name || "";
  const avatar = s?.avatar || p?.avatar;
  const lvl = num(p?.level), elo = num(p?.elo);
  const tint = lvl ? LVL_COLOR(lvl) : "#2ee6c0";

  // форма: последние 30 против всей карьеры
  const g30 = games.reduce((a, g) => ({ k: a.k + (num(g.Kills) || 0), d: a.d + (num(g.Deaths) || 0), w: a.w + (g.Result === "1"), adr: a.adr + (num(g.ADR) || 0), hs: a.hs + (num(g["Headshots %"]) || 0) }), { k: 0, d: 0, w: 0, adr: 0, hs: 0 });
  const kd30 = games.length ? g30.k / Math.max(1, g30.d) : null;
  const kdLife = num(life["Average K/D Ratio"]);
  const adr = games.length ? g30.adr / games.length : num(life.ADR);
  const recent = (life["Recent Results"] || []).slice(-5);

  const maps = (f?.maps || []).map((m) => ({ ...m, id: mapId(m.map), n: num(m.stats?.Matches) || 0, wr: num(m.stats?.["Win Rate %"]) || 0, kd: num(m.stats?.["Average K/D Ratio"]) }))
    .filter((m) => m.n > 0).sort((a, b) => b.n - a.n);
  const bestMap = maps.filter((m) => m.n >= 5).sort((a, b) => b.wr - a.wr)[0];

  // своё из игры (gsi.rs)
  const hist = data?.own ? home?.history?.matches || [] : [];
  const loc = hist.reduce((a, m) => ({ k: a.k + m.kills, d: a.d + m.deaths, hs: a.hs + m.hs, w: a.w + (m.result === "win"), mvp: a.mvp + (m.mvps || 0) }), { k: 0, d: 0, hs: 0, w: 0, mvp: 0 });
  const guns = {};
  hist.forEach((m) => Object.entries(m.weapons || {}).forEach(([w, n]) => { guns[w] = (guns[w] || 0) + n; }));
  const topGuns = Object.entries(guns).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const hlRounds = hist.flatMap((m) => m.rounds || []).filter((r) => r.tags?.length);
  const aces = hlRounds.filter((r) => r.kills >= 5).length, fours = hlRounds.filter((r) => r.kills === 4).length;

  const open = (url) => url && invoke("open_profile_link", { url }).catch(() => {});
  const copyId = () => {
    const id = s?.steamid || p?.steamid;
    if (!id) return;
    navigator.clipboard?.writeText(String(id)).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  const submit = (e) => { e.preventDefault(); load(q); };

  return (
    <div className="pf">
      {/* поиск: свой профиль или любой игрок */}
      <div className="pf-search__row">
        <form className={`pf-search ${busy ? "is-busy" : ""}`} onSubmit={submit} role="search">
          <svg className="pf-search__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" />
          </svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off"
            aria-label={tr("найти игрока")}
            placeholder={hasKey ? tr("SteamID, ссылка на Steam или FACEIT, ник FACEIT") : tr("SteamID или ссылка на профиль Steam")} />
          {/* что распознано во вводе */}
          {q.trim() && <span className="pf-search__kind mono">{kindOf(q.trim(), hasKey)}</span>}
          {q && <button type="button" className="pf-search__clear" onClick={() => setQ("")} aria-label={tr("очистить")}>×</button>}
          <button type="submit" className="pf-search__go" disabled={busy || (!q.trim() && !me?.steamid)}>
            {busy ? <i className="pf-search__spin" aria-hidden="true" /> : null}
            {busy ? tr("ищу...") : tr("найти")}
            {!busy && <kbd>↵</kbd>}
          </button>
          <span className="pf-search__line" aria-hidden="true" />
        </form>
        {me?.steamid && !data?.own && (
          <button type="button" className="pf-btn pf-search__me" onClick={() => { setQ(""); load(""); }}>{tr("мой профиль")}</button>
        )}
      </div>
      {err && <p className="pf-err mono">{err}</p>}
      {!err && data?.steamErr && <p className="pf-err mono">{trError(data.steamErr)}</p>}

      {!data && busy && <Skeleton />}
      {!data && !busy && !err && me && !me.steamid && (
        <p className="pf-empty">{tr("Не нашёл аккаунт Steam на этом компьютере. Введи SteamID или ссылку на профиль выше.")}</p>
      )}

      {data && (
        <div className={`pf-body ${busy ? "is-busy" : ""}`} key={s?.steamid || p?.id}>
          {/* шапка */}
          <section className="pf-hero" style={{ "--tint": tint }}>
            <div className="pf-hero__bg" aria-hidden="true">
              {(p?.cover || avatar) && <img src={p?.cover || avatar} alt="" className={p?.cover ? "" : "is-blur"} />}
            </div>
            <div className="pf-hero__main">
              <div className={`pf-ava is-${s?.online || "offline"}`}>
                {avatar ? <img src={avatar} alt="" /> : <i />}
                {lvl ? <span className="pf-ava__lvl" style={{ "--c": LVL_COLOR(lvl) }}>{lvl}</span> : null}
              </div>
              <div className="pf-id">
                <span className="pf-kicker mono">{data.own ? tr("мой профиль") : tr("профиль игрока")}</span>
                <h1 className="pf-name">{name}</h1>
                {p?.nickname && s?.name && p.nickname !== s.name && <span className="pf-alias mono">Steam: {s.name}</span>}
                <div className="pf-badges">
                  {s?.online && !s.stale && <span className={`pf-badge is-${s.online}`}><i />{s.online === "in-game" ? (s.game || tr("в игре")) : s.online === "online" ? tr("в сети") : tr("не в сети")}</span>}
                  {s?.online && (s.vac ? <span className="pf-badge is-bad"><i />{tr("VAC-бан")}</span> : <span className="pf-badge is-ok"><i />{tr("банов нет")}</span>)}
                  {s?.trade_ban && s.trade_ban !== "None" && <span className="pf-badge is-bad"><i />{tr("бан обмена")}</span>}
                  {s?.limited && <span className="pf-badge is-warn"><i />{tr("ограниченный аккаунт")}</span>}
                  {p?.verified && <span className="pf-badge is-ok"><i />{tr("FACEIT: подтверждён")}</span>}
                  {p?.country && <span className="pf-badge mono">{String(p.country).toUpperCase()}{p.region ? ` · ${p.region}` : ""}</span>}
                  {s?.since && <span className="pf-badge mono">{tr("Steam с {0}", s.since.replace(/^[A-Za-z]+ \d+, /, ""))}</span>}
                  {s && !s.public && <span className="pf-badge is-warn"><i />{tr("профиль скрыт")}</span>}
                  {s?.stale && <span className="pf-badge is-warn" title={tr("Steam временно ограничил запросы — показываю сохранённые данные. Обновится сам при следующем открытии.")}><i />{tr("Steam не ответил: данные сохранены ранее")}</span>}
                </div>
                <div className="pf-links">
                  {s?.url && <button type="button" className="pf-btn" onClick={() => open(s.url)}>Steam ↗</button>}
                  {p?.url && <button type="button" className="pf-btn" onClick={() => open(p.url)}>FACEIT ↗</button>}
                  {(s?.steamid || p?.steamid) && <button type="button" className="pf-btn" onClick={copyId}>{copied ? tr("скопировано") : tr("копировать SteamID")}</button>}
                </div>
              </div>
            </div>
            {p ? <EloRing level={lvl} elo={elo} /> : data.own && me?.total ? (
              <div className="pf-hours"><b><Count to={Math.round(me.total / 60)} /></b><span>{tr("часов в CS2")}</span></div>
            ) : null}
          </section>

          {/* цифры FACEIT */}
          {p ? (
            <section className="pf-tiles">
              <Tile label={tr("матчей")} value={<Count to={num(life.Matches)} />} sub={tr("{0} побед", life.Wins ?? "—")} />
              <Tile label={tr("винрейт")} value={<Count to={num(life["Win Rate %"])} suffix="%" />} sub={<Dots res={recent} />} accent />
              <Tile label="K/D" value={<Count to={kdLife} digits={2} />} sub={kd30 != null ? <Trend now={kd30} was={kdLife} label={tr("за 30 матчей")} digits={2} /> : ""} />
              <Tile label={tr("в голову")} value={<Count to={num(life["Average Headshots %"])} suffix="%" />} sub={games.length ? tr("{0}% за 30 матчей", Math.round(g30.hs / games.length)) : ""} />
              <Tile label="ADR" value={<Count to={adr} digits={1} />} sub={tr("урон за раунд")} />
              <Tile label={tr("лучшая серия")} value={<Count to={num(life["Longest Win Streak"])} />} sub={tr("сейчас: {0}", life["Current Win Streak"] ?? 0)} />
            </section>
          ) : (
            <section className="pf-card pf-cta">
              <div>
                <h2>{hasKey ? tr("Нет аккаунта FACEIT") : tr("Подключи FACEIT")}</h2>
                <p className="dim">{hasKey
                  ? tr("У этого игрока нет профиля FACEIT для CS2 — показываю то, что есть в Steam.")
                  : tr("С ключом FACEIT Data API здесь будут уровень и эло, винрейт, K/D, ADR, форма за последние 30 матчей и статистика по картам. Ключ бесплатный.")}</p>
              </div>
              {!hasKey && <button type="button" className="pf-btn is-go" onClick={onGoSettings}>{tr("в настройки")}</button>}
            </section>
          )}

          <div className="pf-grid">
            {/* форма за последние матчи */}
            {games.length > 0 && (
              <section className="pf-card pf-form span-2">
                <header className="pf-card__head">
                  <h2>{tr("Форма")}</h2>
                  <span className="mono dim">{tr("K/D за последние {0} матчей · {1} побед", games.length, g30.w)}</span>
                </header>
                <FormChart games={games} />
              </section>
            )}

            {/* карты */}
            {maps.length > 0 && (
              <section className="pf-card pf-maps">
                <header className="pf-card__head"><h2>{tr("Карты")}</h2>{bestMap && <span className="mono dim">{tr("лучшая: {0}", mapName(bestMap.id))}</span>}</header>
                <div className="pf-maps__list">
                  {maps.slice(0, 8).map((m, i) => (
                    <div key={m.id} className={`pf-map ${bestMap?.id === m.id ? "is-best" : ""}`} style={{ "--tint": mapTint(m.id), "--i": i }}>
                      {m.img && <img src={m.img} alt="" loading="lazy" />}
                      <div className="pf-map__body">
                        <b>{mapName(m.id)}</b>
                        <span className="mono dim">{tr("{0} матчей", m.n)}{m.kd != null ? ` · K/D ${m.kd.toFixed(2)}` : ""}</span>
                      </div>
                      <div className="pf-map__wr">
                        <b className="mono">{Math.round(m.wr)}%</b>
                        <span className="pf-bar"><i style={{ width: `${Math.min(100, m.wr)}%` }} /></span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* последние матчи */}
            {games.length > 0 && (
              <section className="pf-card pf-last">
                <header className="pf-card__head"><h2>{tr("Последние матчи")}</h2><span className="mono dim">FACEIT</span></header>
                <div className="pf-rows">
                  {[...games].reverse().slice(0, 10).map((g) => {
                    const t = gameTime(g), d = t ? new Date(t) : null, win = g.Result === "1";
                    const id = g["Match Id"];
                    return (
                      <button type="button" key={id || t} className={`pf-row ${win ? "is-win" : "is-loss"}`} style={{ "--tint": mapTint(mapId(g.Map)) }}
                        onClick={() => id && open(`https://www.faceit.com/en/cs2/room/${id}`)} title={tr("открыть матч на FACEIT")}>
                        <i className="pf-row__res">{win ? "W" : "L"}</i>
                        <span className="pf-row__map">{mapName(mapId(g.Map))}</span>
                        <span className="mono pf-row__score">{(g.Score || "").replace(/\s/g, "")}</span>
                        <span className="mono">{g.Kills}-{g.Deaths}-{g.Assists}</span>
                        <span className="mono pf-row__kd">{num(g["K/D Ratio"])?.toFixed(2) ?? "—"}</span>
                        <span className="mono dim">{num(g.ADR) != null ? `${Math.round(num(g.ADR))} ADR` : ""}</span>
                        <span className="mono dim pf-row__when">{d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : ""}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* своё: что записал clipforge */}
            {data.own && (
              <section className="pf-card pf-own span-2">
                <header className="pf-card__head"><h2>{tr("Из игры")}</h2><span className="mono dim">{tr("записывает clipforge, пока открыт")}</span></header>
                <div className="pf-own__row">
                  <div className="pf-own__nums">
                    <div><b><Count to={me?.total ? Math.round(me.total / 60) : null} /></b><span>{tr("часов в CS2")}</span></div>
                    <div><b><Count to={me?.two_weeks != null ? Math.round(me.two_weeks / 6) / 10 : null} digits={1} /></b><span>{tr("часов за 2 недели")}</span></div>
                    <div><b><Count to={hist.length} /></b><span>{tr("матчей записано")}</span></div>
                    <div><b className="accent">{hist.length ? (loc.k / Math.max(1, loc.d)).toFixed(2) : "—"}</b><span>K/D</span></div>
                    <div><b>{hist.length ? `${pct(loc.hs, loc.k)}%` : "—"}</b><span>{tr("в голову")}</span></div>
                    <div><b>{aces}<small> / {fours}</small></b><span>{tr("эйсов / 4K")}</span></div>
                  </div>
                  {topGuns.length > 0 ? (
                    <div className="pf-guns">
                      {topGuns.map(([w, n], i) => (
                        <div key={w} className="pf-gun" style={{ "--i": i }}>
                          <span>{WEAPON(w)}</span>
                          <span className="pf-bar"><i style={{ width: `${(n / topGuns[0][1]) * 100}%` }} /></span>
                          <b className="mono">{n}</b>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="pf-empty">{tr("Сыграй матч с открытым clipforge — здесь появятся любимое оружие, эйсы и K/D.")}</p>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub, accent }) {
  return (
    <div className={`pf-tile ${accent ? "is-accent" : ""}`}>
      <span className="pf-tile__label mono">{label}</span>
      <b className="pf-tile__value">{value}</b>
      <span className="pf-tile__sub dim">{sub}</span>
    </div>
  );
}

// последние результаты: зелёные и красные квадраты
function Dots({ res }) {
  if (!res?.length) return null;
  return <span className="pf-dots">{res.map((r, i) => <i key={i} className={r === "1" ? "is-w" : "is-l"} style={{ "--i": i }}>{r === "1" ? "W" : "L"}</i>)}</span>;
}

function Trend({ now, was, label, digits = 0 }) {
  const up = was == null ? null : now >= was;
  return <span className={`pf-trend ${up == null ? "" : up ? "is-up" : "is-down"}`}>{up == null ? "" : up ? "▲" : "▼"} {now.toFixed(digits)} {label}</span>;
}

// уровень FACEIT: кольцо — сколько пройдено до следующего уровня
function EloRing({ level, elo }) {
  if (!level) return null;
  const lo = LEVELS[level] ?? 0, hi = LEVELS[level + 1];
  const k = hi ? Math.max(0, Math.min(1, (elo - lo) / (hi - lo))) : 1;
  const R = 52, C = 2 * Math.PI * R;
  return (
    <div className="pf-elo" style={{ "--c": LVL_COLOR(level) }}>
      <svg viewBox="0 0 128 128" className="pf-elo__ring" aria-hidden="true">
        <circle cx="64" cy="64" r={R} className="pf-elo__track" />
        <circle cx="64" cy="64" r={R} className="pf-elo__fill" style={{ strokeDasharray: C, "--off": C * (1 - k) }} />
      </svg>
      <div className="pf-elo__mid">
        <b>{level}</b>
        <span className="mono">LVL</span>
      </div>
      <div className="pf-elo__num">
        <b><Count to={elo} /></b>
        <span className="mono dim">{hi ? tr("{0} эло до {1} lvl", hi - elo, level + 1) : tr("максимальный уровень")}</span>
      </div>
    </div>
  );
}

// K/D по матчам: столбики (победа — бирюзовые, поражение — красные) и линия K/D = 1
function FormChart({ games }) {
  const W = 900, H = 170, n = games.length, gap = 4;
  const kds = games.map((g) => num(g["K/D Ratio"]) ?? (num(g.Kills) || 0) / Math.max(1, num(g.Deaths) || 0));
  const max = Math.max(2, ...kds);
  const bw = (W - gap * (n - 1)) / n;
  const y = (v) => H - 18 - (v / max) * (H - 30);
  return (
    <div className="pf-chart__wrap">
    <svg className="pf-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={tr("K/D по матчам")}>
      {games.map((g, i) => {
        const v = kds[i], top = y(v), x = i * (bw + gap);
        return (
          <g key={g["Match Id"] || i} className={g.Result === "1" ? "is-w" : "is-l"} style={{ "--i": i }}>
            <rect x={x} y={top} width={bw} height={Math.max(2, H - 18 - top)} className="pf-chart__bar">
              <title>{`${mapName(mapId(g.Map))} · ${g.Result === "1" ? tr("победа") : tr("поражение")} · ${g.Kills}/${g.Deaths} · K/D ${v.toFixed(2)}${num(g.ADR) != null ? ` · ADR ${Math.round(num(g.ADR))}` : ""}`}</title>
            </rect>
          </g>
        );
      })}
      {/* линия поверх столбиков; подпись — обычным текстом, чтобы не растягивалась вместе с графиком */}
      <line x1="0" x2={W} y1={y(1)} y2={y(1)} className="pf-chart__one" vectorEffect="non-scaling-stroke" />
    </svg>
    <span className="pf-chart__lbl mono" style={{ top: `${(y(1) / H) * 100}%` }}>K/D 1.0</span>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="pf-body pf-skel" aria-busy="true">
      <div className="pf-skel__hero" />
      <div className="pf-tiles">{Array.from({ length: 6 }, (_, i) => <div key={i} className="pf-skel__tile" />)}</div>
      <div className="pf-skel__card" />
    </div>
  );
}
