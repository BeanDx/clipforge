// Что знает вкладка «FPS»: настройки графики CS2 (цена в FPS и влияние на видимость), пресеты
// и программы, которые мешают игре. Значения — как в cs2_video.txt.

// cost: сколько настройка стоит FPS на максимуме; vis: что она даёт для видимости врагов
export const VIDEO = [
  {
    key: "setting.msaa_samples", label: "Сглаживание MSAA", cost: "high",
    values: { 0: "выкл", 2: "2x", 4: "4x", 8: "8x" },
    vis: "4x делает края моделей вдали чётче, 8x уже не заметно, а FPS ест сильно",
  },
  {
    key: "setting.r_csgo_cmaa_enable", label: "CMAA2 (если MSAA выкл)", cost: "low",
    values: { 0: "выкл", 1: "вкл" }, vis: "почти бесплатное сглаживание, но мылит края",
  },
  {
    key: "setting.videocfg_shadow_quality", label: "Качество теней", cost: "mid",
    values: { 0: "низкое", 1: "среднее", 2: "высокое", 3: "очень высокое" },
    vis: "на высоком тень врага видно из-за угла раньше, чем его самого",
  },
  {
    key: "setting.videocfg_dynamic_shadows", label: "Динамические тени", cost: "mid",
    values: { 0: "только солнце", 1: "все" }, vis: "«все» — тени игроков от ламп внутри помещений. Про обычно оставляют",
  },
  {
    key: "setting.videocfg_texture_detail", label: "Детализация текстур", cost: "low",
    values: { 0: "низкая", 1: "средняя", 2: "высокая" }, vis: "на видимость не влияет, ест только видеопамять",
  },
  {
    key: "setting.r_texturefilteringquality", label: "Фильтрация текстур", cost: "low",
    values: { 0: "билинейная", 1: "трилинейная", 2: "AF 2x", 3: "AF 4x", 4: "AF 8x", 5: "AF 16x" },
    vis: "почти бесплатно, пол и стены вдали чётче",
  },
  {
    key: "setting.shaderquality", label: "Качество шейдеров", cost: "mid",
    values: { 0: "низкое", 1: "высокое" }, vis: "только красота. Низкое — меньше бликов",
  },
  {
    key: "setting.videocfg_particle_detail", label: "Частицы", cost: "mid",
    values: { 0: "низкие", 1: "средние", 2: "высокие", 3: "очень высокие" },
    vis: "просадки в дыме и молотовах. На низких видно так же",
  },
  {
    key: "setting.videocfg_ao_detail", label: "Ambient occlusion", cost: "mid",
    values: { 0: "выкл", 1: "среднее", 2: "высокое" }, vis: "затемняет углы, где и так прячутся враги. Лучше выкл",
  },
  {
    key: "setting.videocfg_hdr_detail", label: "HDR", cost: "low",
    values: { "-1": "качество", 3: "производительность" }, vis: "«производительность» — картинка ярче и контрастнее",
  },
  {
    key: "setting.videocfg_fsr_detail", label: "FidelityFX Super Resolution", cost: "none",
    values: { 0: "выкл", 1: "ультра-качество", 2: "качество", 3: "баланс", 4: "производительность" },
    vis: "рендер в меньшем разрешении: FPS выше, но картинка мыльная и враги вдали размыты",
  },
  {
    key: "setting.videocfg_parallax_detail", label: "Parallax occlusion", cost: "low",
    values: { 0: "низкое", 1: "высокое" }, vis: "объём на текстурах, на видимость не влияет",
  },
  {
    key: "setting.r_low_latency", label: "Reflex / Anti-Lag", cost: "none",
    values: { 0: "выкл", 1: "вкл", 2: "вкл + boost" }, vis: "меньше задержка ввода. Держи включённым",
  },
  {
    key: "setting.mat_vsync", label: "Вертикальная синхронизация", cost: "none",
    values: { 0: "выкл", 1: "вкл" }, vis: "вкл добавляет заметную задержку. Только выкл",
  },
];

export const COST = { high: "дорого", mid: "средне", low: "дёшево", none: "—" };

// Пресеты. contrast — «Усиление контраста игроков» (r_player_visibility_mode)
export const PRESETS = {
  fps: {
    label: "Максимум FPS",
    hint: "всё, что не помогает видеть врага, на минимум",
    contrast: "1",
    settings: {
      "setting.msaa_samples": "0", "setting.r_csgo_cmaa_enable": "1", "setting.videocfg_shadow_quality": "0",
      "setting.videocfg_dynamic_shadows": "0", "setting.videocfg_texture_detail": "0", "setting.r_texturefilteringquality": "1",
      "setting.shaderquality": "0", "setting.videocfg_particle_detail": "0", "setting.videocfg_ao_detail": "0",
      "setting.videocfg_hdr_detail": "3", "setting.videocfg_fsr_detail": "0", "setting.videocfg_parallax_detail": "0",
      "setting.r_low_latency": "1", "setting.mat_vsync": "0",
    },
  },
  pro: {
    label: "Видимость как у про",
    hint: "тени врагов и MSAA 4x, остальное на минимум",
    contrast: "1",
    settings: {
      "setting.msaa_samples": "4", "setting.r_csgo_cmaa_enable": "0", "setting.videocfg_shadow_quality": "2",
      "setting.videocfg_dynamic_shadows": "1", "setting.videocfg_texture_detail": "1", "setting.r_texturefilteringquality": "3",
      "setting.shaderquality": "0", "setting.videocfg_particle_detail": "0", "setting.videocfg_ao_detail": "0",
      "setting.videocfg_hdr_detail": "3", "setting.videocfg_fsr_detail": "0", "setting.videocfg_parallax_detail": "0",
      "setting.r_low_latency": "1", "setting.mat_vsync": "0",
    },
  },
};

// Программы, которые мешают игре. always — показывать, даже когда сейчас ничего не грузят
// (встраиваются в игру или пишут видео в фоне)
const P = (label, note, always = false) => ({ label, note, always });
const RGB = "RGB-софт постоянно опрашивает датчики, у многих даёт микрофризы";
const BROWSER = "вкладки с видео и анимацией грузят видеокарту и процессор";
const LAUNCHER = "может качать обновления в фоне";
export const KNOWN = {
  "wallpaper32.exe": P("Wallpaper Engine", "рисует живые обои на видеокарте", true),
  "wallpaper64.exe": P("Wallpaper Engine", "рисует живые обои на видеокарте", true),
  "lively.exe": P("Lively Wallpaper", "рисует живые обои на видеокарте", true),
  "rtss.exe": P("RivaTuner", "встраивает оверлей в игру: бывают микрофризы и лишняя задержка", true),
  "msiafterburner.exe": P("MSI Afterburner", "вместе с RivaTuner встраивается в игру", true),
  "medal.exe": P("Medal", "фоновая запись клипов постоянно кодирует видео", true),
  "overwolf.exe": P("Overwolf", "встраивает оверлеи и часто пишет видео в фоне", true),
  "nvidia overlay.exe": P("NVIDIA Overlay", "Instant Replay пишет видео в фоне", true),
  "obs64.exe": P("OBS", "если сейчас не пишешь и не стримишь — закрой", true),
  "discord.exe": P("Discord", "сам по себе не мешает, а оверлей встраивается в игру: выключи в Discord → Оверлей игры"),
  "armourycrate.exe": P("Armoury Crate", RGB),
  "armourycrate.service.exe": P("Armoury Crate", RGB),
  "icue.exe": P("Corsair iCUE", RGB),
  "nzxt cam.exe": P("NZXT CAM", RGB),
  "signalrgb.exe": P("SignalRGB", RGB),
  "razerappengine.exe": P("Razer Synapse", RGB),
  "lightingservice.exe": P("ASUS Aura", RGB),
  "chrome.exe": P("Chrome", BROWSER),
  "msedge.exe": P("Edge", BROWSER),
  "firefox.exe": P("Firefox", BROWSER),
  "opera.exe": P("Opera", BROWSER),
  "browser.exe": P("Яндекс Браузер", BROWSER),
  "brave.exe": P("Brave", BROWSER),
  "onedrive.exe": P("OneDrive", "синхронизирует файлы: грузит диск и процессор"),
  "msmpeng.exe": P("Защитник Windows", "сейчас сканирует. Подожди или добавь папку CS2 в исключения"),
  "epicgameslauncher.exe": P("Epic Games", LAUNCHER),
  "battle.net.exe": P("Battle.net", LAUNCHER),
  "eadesktop.exe": P("EA App", LAUNCHER),
  "upc.exe": P("Ubisoft Connect", LAUNCHER),
  "qbittorrent.exe": P("qBittorrent", "качает: грузит диск и сеть, пинг может прыгать"),
  "utorrent.exe": P("uTorrent", "качает: грузит диск и сеть, пинг может прыгать"),
};
