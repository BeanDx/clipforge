// Киллфид 3D-превью — как в CS2: справа сверху, строка держится ~5 с, свои фраги в красной рамке.
// Иконки оружия и значки (хедшот, прострел, через смок…) — SVG из игры (scene_icons в scene3d.rs).
import { convertFileSrc } from "@tauri-apps/api/core";

const TICKRATE = 64;
const SHOW = 5 * TICKRATE;
const TEAM = { 2: "s3d-kf__t", 3: "s3d-kf__ct" };

function Icon({ dir, path, fallback, className }) {
  if (!dir) return fallback ? <span className="s3d-kf__wtext">{fallback}</span> : null;
  return (
    <img className={className} src={convertFileSrc(`${dir}\\panorama\\images\\${path}.svg`)} alt={fallback || ""}
      onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement("span"), { className: "s3d-kf__wtext", textContent: fallback || "" })); }} />
  );
}

export default function Killfeed({ kills, tick, me, teamOf, iconDir }) {
  const rows = (kills || []).filter((k) => k.tick <= tick && tick - k.tick < SHOW).slice(-5);
  if (!rows.length) return null;
  const team = (id, t) => TEAM[teamOf(id) ?? t] || "";
  const mark = (name, folder = "hud\\deathnotice") => <Icon dir={iconDir} path={`${folder}\\${name}`} className="s3d-kf__mark" />;
  return (
    <ol className="s3d-kf" aria-label="killfeed">
      {rows.map((k) => {
        const w = (k.w || "").replace(/^weapon_/, "");
        return (
          <li key={`${k.tick}:${k.v}`} className={`s3d-kf__row ${k.a === me ? "is-mine" : ""} ${k.v === me ? "is-dead" : ""}`}>
            {k.blind && mark("blind_kill")}
            {k.a && k.a !== k.v && <b className={team(k.a, k.at)}>{k.an}</b>}
            {k.as && <span className="s3d-kf__assist">+{k.flash && mark("flashbang_assist", "icons\\equipment")}<b className={team(k.as)}>{k.asn}</b></span>}
            <Icon dir={iconDir} path={`icons\\equipment\\${w}`} fallback={w} className="s3d-kf__w" />
            {k.air && mark("inairkill")}
            {k.noscope && mark("noscope")}
            {k.smoke && mark("smoke_kill")}
            {k.wb && mark("penetrate")}
            {k.hs && mark("icon_headshot")}
            <b className={team(k.v, k.vt)}>{k.vn}</b>
          </li>
        );
      })}
    </ol>
  );
}
