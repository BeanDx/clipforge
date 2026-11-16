// Круглая аватарка игрока FACEIT; нет картинки или не загрузилась — первая буква ника.
import { useState } from "react";

export function Avatar({ p, size = 28 }) {
  const [bad, setBad] = useState(false);
  const src = p.avatar || "";
  return (
    <span className="fx-ava" style={{ width: size, height: size }}>
      {src && !bad ? <img src={src} alt="" loading="lazy" onError={() => setBad(true)} /> : <b>{(p.nick || "?").replace(/^[^a-zа-я0-9]+/i, "").slice(0, 1).toUpperCase() || "?"}</b>}
    </span>
  );
}
