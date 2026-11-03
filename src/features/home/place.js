// Где ты сейчас в CS2 — по данным игры (gsi.rs, LiveView): режим, карта и сервер.
// Сервер известен из лога консоли (параметр запуска -condebug): официальный Valve, комьюнити
// (название и игроки — запросом к самому серверу), своя игра с ботами или просмотр демки.
import { tr } from "../../i18n";
import { mapName } from "../match/dossier";

const MODES = {
  competitive: "Соревновательный", premier: "Премьер", casual: "Обычный", deathmatch: "Бой насмерть",
  scrimcomp2v2: "Напарники", wingman: "Напарники", gungameprogressive: "Гонка вооружений", armsrace: "Гонка вооружений",
  training: "Тренировка", custom: "Свой режим", survival: "Запретная зона", cooperative: "Кооператив",
  coopmission: "Кооператив", retake: "Ретейки", retakes: "Ретейки", rush: "Штурм",
};
// режимы без раундов и командного счёта: бой насмерть, гонка вооружений
export const roundless = (m) => ["deathmatch", "gungameprogressive", "gungametrbomb", "armsrace"].includes(m);
export const modeName = (m) => (m ? tr(MODES[m] || m.replace(/_/g, " ")) : "");

// { kind, badge, title, sub, hint } — kind: off | menu | official | community | local | demo | game
export function placeOf(live) {
  if (!live?.connected) return { kind: "off", badge: "OFF", title: tr("CS2 не запущена"), sub: "" };
  const s = live.server || {};
  // у карт Штурма внутренние имена (rush_001…), настоящее название игра не присылает — не показываем
  const map = /^(de_|cs_)?rush_d+$/i.test(live.map || "") ? "" : mapName(live.map);
  const mode = modeName(live.mode);
  if (!live.map || live.activity === "menu" && !s.kind) {
    return { kind: "menu", badge: "MENU", title: tr("В главном меню CS2"), sub: tr("ждём матч") };
  }
  const hint = s.log ? "" : tr("сервер не виден: добавь -condebug в параметры запуска CS2");
  if (s.kind === "official") {
    return { kind: "official", badge: "VALVE", title: [mode, map].filter(Boolean).join(" · "), sub: tr("официальный сервер Valve") };
  }
  if (s.kind === "community") {
    const players = s.max ? tr("{0}/{1} игроков", s.players, s.max) : "";
    return {
      kind: "community", badge: "SERVER", title: s.name || tr("Сервер {0}", s.addr),
      sub: [mode, map, players].filter(Boolean).join(" · "), addr: s.addr,
    };
  }
  if (s.kind === "local") return { kind: "local", badge: "LOCAL", title: tr("Своя игра"), sub: [mode, map, tr("локальный сервер")].filter(Boolean).join(" · ") };
  if (s.kind === "demo") return { kind: "demo", badge: "DEMO", title: tr("Смотришь демку"), sub: map };
  return { kind: "game", badge: "LIVE", title: [mode, map].filter(Boolean).join(" · ") || tr("В игре"), sub: "", hint };
}
