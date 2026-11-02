import { Component } from "react";
import HighlightRenderer from "./app/HighlightRenderer";
import { tr, useLang } from "./i18n";

// Если что-то в интерфейсе упало при отрисовке — вместо белого экрана показываем ошибку
// и кнопку перезагрузки (текст ошибки нужен, чтобы понять, что сломалось)
class Crash extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info?.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <b>{tr("Что-то сломалось в интерфейсе")}</b>
        <span className="dim">{tr("Перезагрузи окно. Если повторится, пришли этот текст разработчику:")}</span>
        <pre className="mono">{String(error?.stack || error)}</pre>
        <button type="button" className="go" onClick={() => location.reload()}>{tr("Перезагрузить")}</button>
      </div>
    );
  }
}

export default function App() {
  // смена языка в «Настройках» перерисовывает весь интерфейс сразу
  useLang();
  return <Crash><HighlightRenderer /></Crash>;
}
