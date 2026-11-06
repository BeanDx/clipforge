@echo off
chcp 65001 >nul
rem Собирает WASM-парсер демок для блока «Кинь свою демку» на сайте и кладёт его в site\parser.
rem Исходники: github.com/LaihoE/demoparser (MIT) — та же библиотека, что разбирает демки в приложении.
rem Нужны Rust (rustup) и git. Первый запуск ~5-10 минут (ставится wasm-pack), потом быстрее.
setlocal
set "SITE=%~dp0"
set "WORK=%TEMP%\clipforge-demoparser"

where cargo >nul 2>nul || (echo Нет Rust: поставь с https://rustup.rs & exit /b 1)
where git >nul 2>nul || (echo Нет git & exit /b 1)

if not exist "%WORK%" git clone --depth 1 https://github.com/LaihoE/demoparser.git "%WORK%" || exit /b 1
rustup target add wasm32-unknown-unknown || exit /b 1
where wasm-pack >nul 2>nul || cargo install wasm-pack --locked || exit /b 1

pushd "%WORK%\src\wasm"
wasm-pack build --release --target no-modules --out-dir www\pkg || (popd & exit /b 1)
popd

if not exist "%SITE%parser" mkdir "%SITE%parser"
copy /y "%WORK%\src\wasm\www\pkg\demoparser2.js" "%SITE%parser\" >nul || exit /b 1
copy /y "%WORK%\src\wasm\www\pkg\demoparser2_bg.wasm" "%SITE%parser\" >nul || exit /b 1
node "%SITE%scan.mjs"
echo.
echo Готово: site\parser\demoparser2.js и demoparser2_bg.wasm
endlocal
