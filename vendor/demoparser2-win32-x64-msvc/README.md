# demoparser2 0.42.2 (Windows x64)

Нативный модуль demoparser2, собранный из master LaihoE/demoparser
(коммит dd71c09, 2026-11-12) с фиксом под CS2 build 14197: на npm пока лежит 0.42.0,
которая демки с этого патча не читает (EntityNotFound, VectorResizeFailure).

Подключается через `overrides` в package.json. Когда 0.42.2 или новее выйдет на npm —
убрать override, удалить эту папку и поднять `@laihoe/demoparser2` до новой версии.

Сборка: в `src/node` репозитория `cargo build --release` с `PROTOC` = protoc 21.12
(новее не годится: протофайлы Valve конфликтуют с editions) и `git config core.longpaths true`;
`target/release/laihoe_demoparser2.dll` переименовать в `demoparser2.win32-x64-msvc.node`.
