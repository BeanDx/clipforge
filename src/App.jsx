import HighlightRenderer from "./HighlightRenderer";
import { useLang } from "./i18n";

export default function App() {
  // смена языка в «Настройках» перерисовывает весь интерфейс сразу
  useLang();
  return <HighlightRenderer />;
}
