// «Досье матча»: что ещё можно достать из .dem — счёт, сервер, прицелы игроков и
// статистика, которую не показывает ни игра, ни обычный разбор (данные — scripts/info.cjs).
import { useState } from "react";

import { tr } from "./i18n";
const MAPS = {
  de_dust2: "Dust II", de_mirage: "Mirage", de_inferno: "Inferno", de_nuke: "Nuke", de_ancient: "Ancient",
  de_anubis: "Anubis", de_vertigo: "Vertigo", de_overpass: "Overpass", de_train: "Train", de_italy: "Italy", de_office: "Office",
};
// фирменные оттенки карт — для полосы в шапке досье и значка в архиве
const MAP_TINT = {
  de_dust2: "#d9a55b", de_mirage: "#e0b46c", de_inferno: "#e2683c", de_nuke: "#4fa3d9", de_ancient: "#5fae6e",
  de_anubis: "#3fb6b0", de_vertigo: "#8aa6c8", de_overpass: "#7fa86b", de_train: "#9a9fa6",
};
export const mapName = (m) => MAPS[m] || (m || "").replace(/^(de|cs|ar)_/, "").replace(/^\w/, (c) => c.toUpperCase());
export const mapTint = (m) => MAP_TINT[m] || "#2ee6c0";
const FACEIT_COLOR = (l) => (l >= 10 ? "#fe1f00" : l >= 8 ? "#ff6309" : l >= 4 ? "#ffc800" : l >= 2 ? "#1ce400" : "#eeeeee");
const fmtDur = (s) => tr("{0} мин {1} с", Math.floor(s / 60), String(s % 60).padStart(2, "0"));
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const WEAPON = (w) => (w || "").replace(/_silencer$/, "-S").replace(/^m4a1-S$/, "M4A1-S").toUpperCase();

// краткая выжимка для карточки в архиве
export function infoSummary(info) {
  if (!info) return null;
  const [a, b] = info.teams || [];
  return { map: info.map, source: info.source, matchSec: info.matchSec, score: a && b ? `${a.score}:${b.score}` : null };
}

export function FaceitLevel({ level, elo }) {
  if (!level) return null;
  return (
    <span className="fc-lvl" style={{ "--c": FACEIT_COLOR(level) }} title={elo ? tr("FACEIT {0} · {1} эло", level, elo) : `FACEIT ${level}`}>
      {level}
    </span>
  );
}

const COLS = [
  ["kda", "K / D / A"],
  ["adr", "ADR", "Средний урон за раунд."],
  ["hs", "HS%", "Доля киллов в голову."],
  ["accuracy", "Точность", "Сколько выстрелов из огнестрела попало в противника. Дробовики считают каждую дробину отдельно."],
  ["strafe", "Контрстрейф", "Доля выстрелов из винтовок и снайперок, сделанных почти без движения (скорость ниже 34% от максимальной - порог, когда оружие стреляет точно). Показывает, гасит ли игрок инерцию перед выстрелом."],
  ["ttk", "TTK", "Время от первого попадания по противнику до его смерти, в среднем. Ваншоты - 0 мс."],
  ["open", "Открытия", "Первые киллы раунда / первые смерти раунда."],
  ["dist", "Пробежал", "Сколько метров игрок прошел за матч (по позициям каждые 8 тиков, только пока жив)."],
  ["ping", "Пинг", "Средний пинг до сервера за матч."],
  ["xhair", "Прицел", "Код прицела игрока - нажми, чтобы скопировать. В CS2: Настройки → Игра → Прицел → Импорт."],
];

function cell(p, k) {
  switch (k) {
    case "kda": return <span>{p.kills} / {p.deaths} / {p.assists}</span>;
    case "hs": return `${p.hs}%`;
    case "accuracy": return p.accuracy != null ? `${p.accuracy}%` : "-";
    case "strafe": return p.strafe != null ? <span className={p.strafe >= 85 ? "dz-good" : p.strafe < 70 ? "dz-bad" : ""}>{p.strafe}%</span> : "-";
    case "ttk": return p.ttk != null ? tr("{0} мс", p.ttk) : "-";
    case "open": return <span><span className="dz-good">{p.openK}</span> / <span className="dz-bad">{p.openD}</span></span>;
    case "dist": return tr("{0} км", (p.dist / 1000).toFixed(1));
    case "ping": return p.ping != null ? `${p.ping}` : "-";
    default: return p[k];
  }
}

function Crosshair({ code }) {
  const [copied, setCopied] = useState(false);
  if (!code) return <span className="dim">-</span>;
  return (
    <button type="button" className={`dz-xhair ${copied ? "is-copied" : ""}`} title={code}
      onClick={() => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })}>
      <i />{copied ? tr("скопирован") : tr("копировать")}
    </button>
  );
}

const SECTIONS = [["players", "Игроки"], ["facts", "Факты"], ["chat", "Чат"], ["server", "Сервер"]];

export function MatchDossier({ info, busy, playerId, faceit, faceitErr, Hint, onPick, clipCount, onCard }) {
  const [sec, setSec] = useState("players");
  if (!info) {
    return <p className="empty dim">{busy ? tr("Разбираю матч по тикам...") : tr("Загрузи демку - здесь будет все, что из нее можно достать.")}</p>;
  }
  const [t1, t2] = info.teams || [];
  const teamAvg = (side) => {
    const ls = info.players.filter((p) => p.side === side).map((p) => faceit?.[p.id]?.[0]).filter(Boolean);
    return ls.length ? (ls.reduce((s, x) => s + x, 0) / ls.length).toFixed(1) : null;
  };
  const me = info.players.find((p) => p.id === playerId);
  const f = info.facts || {};

  return (
    <div className="dz" style={{ "--map": mapTint(info.map) }}>
      <div className="dz-hero">
        <div className="dz-map">
          <span className="mono dim">{info.map}</span>
          <b>{mapName(info.map)}</b>
          <span className="mono dim">{info.source} · {fmtDur(info.matchSec)} · {info.rounds} {tr("раундов")}</span>
        </div>
        {t1 && t2 && (
          <div className="dz-score">
            {[t1, t2].map((t, i) => (
              <div key={t.side} className={`dz-team dz-team--${t.side.toLowerCase()} ${t.score > (i ? t1 : t2).score ? "is-win" : ""}`}>
                <span className="mono dim">{t.side}{teamAvg(t.side) && <> {tr("· ср. FACEIT")} <b>{teamAvg(t.side)}</b></>}</span>
                <b className="dz-team__name">{t.name}</b>
                <span className="dz-team__score">{t.score}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dz-tabs" role="tablist">
        {SECTIONS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={sec === k} className={sec === k ? "is-on" : ""} onClick={() => setSec(k)}>
            {tr(l)}{k === "chat" && info.chat.length ? <span className="mono dim"> {info.chat.length}</span> : null}
          </button>
        ))}
        {faceitErr && <span className="mono err dz-ferr">{faceitErr}</span>}
        {onCard && (
          <button type="button" className="dz-card-btn" onClick={onCard}
            title={tr("Картинка 1080×1920 с итогом матча выбранного игрока - для сторис или Discord")}>
            {tr("✦ Карточка игрока")}
          </button>
        )}
      </div>

      {sec === "players" && (
        <div className="dz-table-wrap">
          <table className="dz-table">
            <thead>
              <tr>
                <th>{tr("Игрок")}</th>
                {COLS.map(([k, l, h]) => <th key={k}>{tr(l)}{h && <Hint text={tr(h)} float />}</th>)}
              </tr>
            </thead>
            <tbody>
              {["CT", "T"].map((side) => info.players.filter((p) => p.side === side).map((p, i) => (
                <tr key={p.id} className={`${p.id === playerId ? "is-me" : ""} ${i === 0 ? "is-first" : ""} ${onPick ? "is-pickable" : ""} dz-row--${side.toLowerCase()}`}
                  onClick={onPick ? () => onPick(p.id) : undefined} title={onPick ? tr("Выбрать игрока для хайлайтов") : undefined}>
                  <td className="dz-name">
                    <FaceitLevel level={faceit?.[p.id]?.[0]} elo={faceit?.[p.id]?.[1]} /><b>{p.name}</b>
                    {clipCount?.[p.id] > 0 && <span className="dz-clips mono">{clipCount[p.id]} {tr("клип.")}</span>}
                  </td>
                  {COLS.map(([k]) => <td key={k} className="mono">{k === "xhair" ? <Crosshair code={p.crosshair} /> : cell(p, k)}</td>)}
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}

      {sec === "facts" && (
        <div className="dz-facts">
          {f.longest && (
            <div className="dz-fact dz-fact--wide">
              <span className="mono dim">{tr("самый дальний килл")}</span>
              <b>{Math.round(f.longest.dist)} {tr("м")}</b>
              <span>{f.longest.name} → {f.longest.victim} · {WEAPON(f.longest.weapon)} {tr("· раунд")} {f.longest.round}</span>
            </div>
          )}
          {f.fastestOpen && (
            <div className="dz-fact dz-fact--wide">
              <span className="mono dim">{tr("самое быстрое открытие")}</span>
              <b>{f.fastestOpen.sec.toFixed(1)} {tr("с")}</b>
              <span>{tr("после фризтайма ·")} {f.fastestOpen.name} → {f.fastestOpen.victim} · {WEAPON(f.fastestOpen.weapon)}</span>
            </div>
          )}
          {[
            [tr("сквозь стену"), f.wallbangs], [tr("сквозь дым"), f.smoke], [tr("в прыжке"), f.air], [tr("без прицела"), f.noscope],
            [tr("ослепленным"), f.blind], [tr("ножом"), f.knife], [tr("в голову"), tr("{0} из {1}", f.hs, f.kills)], [tr("выстрелов"), f.shots],
            [tr("установок / разминирований"), `${f.plants} / ${f.defuses}`], [tr("слышимых шагов"), f.footsteps], [tr("тимкиллов"), f.team],
          ].map(([l, v]) => (
            <div key={l} className="dz-fact"><span className="mono dim">{l}</span><b>{v ?? 0}</b></div>
          ))}
          {me && (
            <div className="dz-fact dz-fact--me">
              <span className="mono dim">{tr("ты ·")} {me.name}</span>
              <span>
                {tr("любимое оружие")} <b>{WEAPON(me.fav) || "-"}</b> {tr("· самый дальний килл")} <b>{me.longest} {tr("м")}</b> {tr("· слепил врагов")} <b>{me.flashSec} {tr("с")}</b> ·
                {" "}{tr("шагов слышно")} <b>{me.steps}</b> {tr("· сквозь стены")} <b>{me.wallbangs}</b> {tr("· сквозь дым")} <b>{me.smokeKills}</b>
              </span>
            </div>
          )}
        </div>
      )}

      {sec === "chat" && (
        info.chat.length ? (
          <ul className="dz-chat">
            {info.chat.map((c, i) => (
              <li key={i}><span className="mono dim">{fmtClock(c.tick / info.tickrate)}</span><b>{c.name}</b><span>{c.text}</span></li>
            ))}
          </ul>
        ) : <p className="empty dim">{tr("В этом матче никто не писал в чат.")}</p>
      )}

      {sec === "server" && (
        <div className="dz-server mono">
          {[
            [tr("сервер"), info.server || "-"], [tr("источник"), info.source], [tr("патч игры"), info.patch], [tr("формат демки"), info.demoVersion],
            [tr("тикрейт"), tr("{0} тиков/с", info.tickrate)], [tr("длина"), tr("{0} тиков", info.ticks.toLocaleString("ru"))],
            ...(info.faceitId ? [[tr("матч FACEIT"), info.faceitId]] : []),
            ...info.cvars,
          ].map(([k, v]) => <div key={k}><span className="dim">{k}</span><span>{String(v)}</span></div>)}
        </div>
      )}
    </div>
  );
}
