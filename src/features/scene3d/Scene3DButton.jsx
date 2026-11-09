// Кнопка «3D» на карточке момента. Само окно и three.js грузятся только по нажатию —
// на запуск и остальную программу это не влияет.
import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";
import { tr } from "../../i18n";
import "./button.css";

const Scene3DModal = lazy(() => import("./Scene3DModal"));

export default function Scene3DButton(props) {
  const [open, setOpen] = useState(false);
  if (!props.clip) return null;
  return (
    <>
      <button type="button" className="mo-3d mono" onClick={() => setOpen(true)}
        title={tr("Посмотреть момент в 3D: карта, игроки, камера глазами игрока и облёт - ещё до записи")}>3D</button>
      {open && createPortal(
        <Suspense fallback={null}>
          <Scene3DModal {...props} onClose={() => setOpen(false)} />
        </Suspense>,
        // внутрь .app: там переменные цветов и сброс стилей кнопок
        document.querySelector(".app") || document.body,
      )}
    </>
  );
}
