# Лендинг clipforge

Статический сайт без сборки. Деплой — `.github/workflows/pages.yml` (GitHub Pages, Source: GitHub Actions).

```bash
node site/serve.mjs          # локально: http://localhost:4321
```

| Файл | Что это |
|---|---|
| `index.html`, `style.css` | разметка (русский текст) и стили |
| `main.js` | английский перевод, анимации, калькулятор баллов, релизы с GitHub, разбор демки |
| `scene.js` | 3D-кузница в герое (Three.js) |
| `lyrics3d.js` | песочница «текст песни в 3D» |
| `config.js` | ссылки Discord / Telegram / YouTube и код GoatCounter — пустое значение скрывает блок |
| `moments.js` | копия правил моментов из приложения — обновлять `node site/sync-moments.mjs` |
| `demo-worker.js` | разбор `.dem` в браузере через WASM-парсер из `parser/` |
| `media/` | шоурил и «до / после» — делаются `node site/make-media.mjs` |
| `og.png` | превью ссылки 1200×630 для Discord / Telegram |

Скриншоты не дублируются: деплой и `serve.mjs` берут их из `docs/screenshots` (путь `shots/`).

## Разбор демки в браузере (`parser/`)

Блок «Кинь свою демку» появляется, только если рядом лежат `parser/demoparser2.js` и `parser/demoparser2_bg.wasm`.
Пакет `demoparser2` из npm (0.15) старый и современные демки не читает (`EntityNotFound`), поэтому WASM
собирается из исходников [LaihoE/demoparser](https://github.com/LaihoE/demoparser) (MIT):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
git clone --depth 1 https://github.com/LaihoE/demoparser.git
cd demoparser/src/wasm
wasm-pack build --release --target no-modules --out-dir www/pkg
```

Потом скопировать `www/pkg/demoparser2.js` и `www/pkg/demoparser2_bg.wasm` в `site/parser/`.

## Свой домен

Купить домен → в DNS добавить `CNAME` на `beandx.github.io` → Settings → Pages → Custom domain.
Потом поменять `https://beandx.github.io/clipforge/` в `index.html` (og:url, og:image, twitter:image, canonical).
