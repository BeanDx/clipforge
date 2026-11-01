// Выбор скинов: каталог с картинками (открытая база ByMykel/CSGO-API) + список того,
// что игрок держал в выбранных клипах. Сама подмена — в src-tauri/src/skins.rs.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import { tr, trError } from "./i18n";
const CATALOG_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json";
const KNIFE_CAT = "sfui_invpanel_filter_melee";
const GLOVE_CAT = "sfui_invpanel_filter_gloves";

let catalogPromise = null;
// Каталог ~5 МБ: качаем один раз за сеанс и раскладываем по оружию
export function loadCatalog() {
  catalogPromise ??= fetch(CATALOG_URL)
    .then((r) => { if (!r.ok) throw new Error(tr("каталог скинов: HTTP {0}", r.status)); return r.json(); })
    .then((list) => {
      const byWeapon = new Map(), names = new Map(), knives = new Map(), gloves = new Map();
      for (const s of list) {
        const def = s.weapon?.weapon_id;
        if (def == null || !s.paint_index) continue;
        const skin = {
          def, paint: Number(s.paint_index), name: s.name, short: s.pattern?.name || s.name.split(" | ")[1] || s.name,
          image: s.image, color: s.rarity?.color || "#b0c3d9", min: s.min_float ?? 0, max: s.max_float ?? 1,
        };
        if (!byWeapon.has(def)) byWeapon.set(def, []);
        byWeapon.get(def).push(skin);
        names.set(def, s.weapon.name);
        const cat = s.category?.id;
        if (cat === KNIFE_CAT) knives.set(def, s.weapon.name);
        if (cat === GLOVE_CAT) gloves.set(def, s.weapon.name);
      }
      return { byWeapon, names, knives, gloves };
    })
    .catch((e) => { catalogPromise = null; throw e; });
  return catalogPromise;
}

const WEAR = [[0.07, "Factory New"], [0.15, "Minimal Wear"], [0.38, "Field-Tested"], [0.45, "Well-Worn"], [1.01, "Battle-Scarred"]];
const wearName = (w) => WEAR.find(([max]) => w < max)[1];

const findSkin = (cat, def, paint) => cat?.byWeapon.get(def)?.find((s) => s.paint === paint);

// План для Rust: только числа. Оружие — по номеру предмета строкой. Нож один на весь хайлайт:
// им становятся все ножи игрока (и за T, и за CT); если модель другая, Rust подменит номер,
// модель, subclass и добавит скелет анимаций. Перчатки — только своя модель.
export function planForRust(plan) {
  const fin = (s) => ({ paint: s.paint, seed: s.seed, wear: s.wear });
  const weapons = Object.fromEntries(Object.entries(plan.weapons || {}).map(([d, s]) => [d, fin(s)]));
  return {
    weapons,
    knife: plan.knife ? { def: plan.knife.def, finish: fin(plan.knife) } : null,
    gloves: plan.gloves ? { def: plan.gloves.def, finish: fin(plan.gloves) } : null,
  };
}
export const planIsEmpty = (p) => !Object.keys(p.weapons || {}).length && !p.knife && !p.gloves;

function SkinIcon({ skin, size = "md" }) {
  return (
    <span className={`sk-icon sk-icon--${size}`} style={{ "--rar": skin?.color || "var(--line-hi)" }}>
      {skin?.image ? <img src={skin.image} alt="" loading="lazy" /> : <i className="sk-icon__none" />}
    </span>
  );
}

// Окно выбора: сетка скинов, для ножа и перчаток — ещё и выбор модели
function Picker({ cat, title, defs, current, original, onPick, onClose }) {
  const [def, setDef] = useState(current?.def ?? original?.def ?? defs[0]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(current || null);
  const [seed, setSeed] = useState(current?.seed ?? original?.seed ?? 1);
  const [wear, setWear] = useState(current?.wear ?? original?.wear ?? 0.05);
  const list = useMemo(() => {
    const all = cat.byWeapon.get(def) || [];
    const s = q.trim().toLowerCase();
    return s ? all.filter((x) => x.name.toLowerCase().includes(s)) : all;
  }, [cat, def, q]);
  const range = sel ? [sel.min, sel.max] : [0, 1];

  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  // Портал в .app: у блоков страницы есть transform (анимация появления), и position: fixed
  // внутри них считался бы от блока, а не от окна. В .app — чтобы работали цвета темы.
  return createPortal(
    <div className="sk-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sk-modal__box">
        <header className="sk-modal__head">
          <h3>{title}</h3>
          <input className="sk-search mono" placeholder={tr("поиск скина...")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <button type="button" className="sk-x" onClick={onClose} aria-label={tr("Закрыть")}>×</button>
        </header>
        {defs.length > 1 && (
          <div className="sk-types">
            {defs.map((d) => (
              <button key={d} type="button" className={d === def ? "is-on" : ""} onClick={() => { setDef(d); setSel(null); }}>
                {cat.names.get(d)}{d === original?.def && <em>{tr("сейчас")}</em>}
              </button>
            ))}
          </div>
        )}
        <div className="sk-grid">
          {list.map((s) => (
            <button key={`${s.def}-${s.paint}`} type="button" className={`sk-card ${sel?.paint === s.paint && sel?.def === s.def ? "is-on" : ""}`}
              style={{ "--rar": s.color }} title={s.name}
              onClick={() => { setSel(s); setWear((w) => Math.min(Math.max(w, s.min), s.max)); }}>
              <img src={s.image} alt="" loading="lazy" />
              <span className="sk-card__name">{s.short}</span>
              {original?.def === s.def && original?.paint === s.paint && <em className="sk-card__now">{tr("сейчас")}</em>}
            </button>
          ))}
          {!list.length && <p className="empty dim">{tr("Ничего не найдено")}</p>}
        </div>
        <footer className="sk-modal__foot">
          <label className="num sk-seed">
            <span className="mono dim">{tr("паттерн (seed)")}</span>
            <input className="mono" type="number" min={0} max={1000} value={seed} onChange={(e) => setSeed(Math.max(0, Math.min(1000, +e.target.value || 0)))} />
          </label>
          <label className="field sk-wear">
            <span className="field__row"><span>{tr("Износ")}</span><b className="mono accent">{wear.toFixed(3)} · {wearName(wear)}</b></span>
            <input type="range" min={range[0]} max={range[1]} step={0.001} value={wear}
              style={{ "--pct": `${((wear - range[0]) / (range[1] - range[0] || 1)) * 100}%` }}
              onChange={(e) => setWear(+e.target.value)} />
          </label>
          <button type="button" className="go go--ghost" onClick={() => onPick(null)}>{tr("Оставить как в демке")}</button>
          <button type="button" className="go sk-apply" disabled={!sel} onClick={() => onPick({ ...sel, seed, wear })}>{tr("Применить")}</button>
        </footer>
      </div>
    </div>,
    document.querySelector(".app") || document.body,
  );
}

// Строка предмета: иконка, оружие, скин (исходный или выбранный), кнопка
function Row({ label, orig, chosen, disabledNote, onOpen, onReset, note }) {
  const shown = chosen || orig;
  return (
    <li className={`sk-row ${disabledNote ? "is-off" : ""} ${chosen ? "is-changed" : ""}`}>
      <SkinIcon skin={shown} />
      <span className="sk-row__text">
        <b>{label}</b>
        <span className="sk-row__skin" style={{ color: shown?.color }}>
          {shown ? shown.short || shown.name : tr("стандартная раскраска")}
          {chosen && <em className="mono dim"> · {wearName(chosen.wear)} · seed {chosen.seed}</em>}
        </span>
        {(disabledNote || note) && <small className="dim">{disabledNote || note}</small>}
      </span>
      {chosen && <button type="button" className="chip" onClick={onReset} title={tr("Вернуть скин из демки")}>↺</button>}
      <button type="button" className="chip sk-row__btn" disabled={!!disabledNote} onClick={onOpen}>
        {chosen ? tr("Изменить") : tr("Сменить скин")}
      </button>
    </li>
  );
}

export function SkinsPanel({ demo, playerId, ranges, plan, setPlan }) {
  const [cat, setCat] = useState(null);
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [picker, setPicker] = useState(null); // { kind: "weapon"|"knife"|"gloves", def? }
  const key = `${demo?.path}|${playerId}|${ranges.map((r) => r.join("-")).join(",")}`;

  useEffect(() => { loadCatalog().then(setCat, (e) => setErr(String(e.message || e))); }, []);
  useEffect(() => { setScan(null); }, [key]);

  const runScan = async () => {
    setBusy(true); setErr("");
    try { setScan(await invoke("scan_items", { path: demo.path, steamid: playerId, ranges })); }
    catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const origOf = (item) => item?.finish && { ...(findSkin(cat, item.def, item.finish.paint) || { name: `paint ${item.finish.paint}` }), ...item.finish, def: item.def };
  // нож, который показываем как «текущий»: со скином, если такой есть
  const knife = scan?.knives?.find((k) => k.finish) || scan?.knives?.[0];
  // скин перчаток, выбранный для другой модели, не показываем как выбранный
  const sameModel = (s, item) => (s && item && s.def === item.def ? s : null);
  const resetWeapon = (def) => setPlan((o) => { const n = { ...o, weapons: { ...o.weapons } }; delete n.weapons[def]; return n; });

  const pick = (choice) => {
    const p = picker;
    setPicker(null);
    setPlan((old) => {
      const next = { ...old, weapons: { ...(old.weapons || {}) } };
      if (p.kind === "gloves") next.gloves = choice;
      else if (p.kind === "knife") next.knife = choice;
      else if (choice) next.weapons[p.def] = choice;
      else delete next.weapons[p.def];
      return next;
    });
  };

  if (!demo) return <p className="empty dim">{tr("Загрузи демку, чтобы выбрать скины.")}</p>;
  return (
    <div className="sk">
      {!scan ? (
        <div className="sk-start">
          <p className="dim">{tr("Найду, какое оружие игрок держит в выбранных клипах: менять имеет смысл только то, что попадет в кадр. Нож и перчатки доступны всегда.")}</p>
          <button type="button" className="go go--ghost" disabled={busy || !playerId || !ranges.length} onClick={runScan}>
            {busy ? tr("Разбираю демку...") : tr("Найти оружие в клипах")}
          </button>
        </div>
      ) : !cat ? (
        <p className="dim">{err ? "" : tr("Загружаю каталог скинов...")}</p>
      ) : (
        <ul className="sk-list">
          {scan.weapons.map((w) => (
            <Row key={w.def} label={cat.names.get(w.def) || w.class.replace(/^C(Weapon)?/, "")}
              orig={origOf(w)} chosen={plan.weapons?.[w.def]}
              disabledNote={!w.finish && tr("Стандартная раскраска: в демке нет данных скина, заменить нельзя")}
              onOpen={() => setPicker({ kind: "weapon", def: w.def })} onReset={() => resetWeapon(w.def)} />
          ))}
          {!scan.weapons.length && <li className="dim sk-empty">{tr("В этих клипах игрок не держал огнестрельного оружия.")}</li>}
          {/* один нож на весь хайлайт: им становятся все ножи игрока, и за T, и за CT */}
          {knife ? (
            <Row label={tr("Нож · {0}", plan.knife ? cat.names.get(plan.knife.def) : cat.names.get(knife.def) || tr("стандартный"))}
              orig={origOf(knife)} chosen={plan.knife}
              note={plan.knife && scan.knives.some((k) => !k.finish)
                ? tr("У стандартного ножа нет данных скина: на нем сменится только модель, без раскраски")
                : scan.knives.length > 1 ? tr("Заменит все ножи игрока - и за T, и за CT") : tr("Любая модель ножа и раскраска")}
              onOpen={() => setPicker({ kind: "knife", def: knife.def })} onReset={() => setPlan((o) => ({ ...o, knife: null }))} />
          ) : <li className="dim sk-empty">{tr("Ножа у игрока в демке не найдено.")}</li>}
          <Row label={tr("Перчатки{0}", scan.gloves?.def ? ` · ${cat.names.get(scan.gloves.def) || ""}` : "")}
            orig={origOf(scan.gloves)} chosen={sameModel(plan.gloves, scan.gloves)}
            disabledNote={!scan.gloves?.finish && tr("Стандартные перчатки: в демке нет данных скина, заменить нельзя")}
            onOpen={() => setPicker({ kind: "gloves" })} onReset={() => setPlan((o) => ({ ...o, gloves: null }))} />
        </ul>
      )}
      {err && <p className="mono err">{trError(err)}</p>}
      {picker && cat && (
        <Picker cat={cat}
          title={picker.kind === "gloves" ? cat.names.get(scan.gloves.def) || tr("Перчатки") : picker.kind === "knife" ? tr("Нож") : cat.names.get(picker.def)}
          defs={picker.kind === "gloves" ? [scan.gloves.def]
            : picker.kind === "knife" ? [picker.def, ...[...cat.knives.keys()].filter((d) => d !== picker.def)]
            : [picker.def]}
          current={picker.kind === "gloves" ? sameModel(plan.gloves, scan.gloves) : picker.kind === "knife" ? plan.knife : plan.weapons?.[picker.def]}
          original={origOf(picker.kind === "gloves" ? scan.gloves : picker.kind === "knife" ? knife : scan.weapons.find((w) => w.def === picker.def))}
          onPick={pick} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
