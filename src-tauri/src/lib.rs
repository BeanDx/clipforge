mod faceit;
mod friends;
mod display;
mod ffmpeg;
mod gallery;
mod gsi;
mod hlae;
mod montage;
mod music;
mod overlay;
mod preflight;
mod profile;
mod render;
mod reshade;
mod sky;
mod skins;
mod toast;
mod tray;
mod valve;
mod whisper;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Установленная программа и `tauri dev` с одним identifier делят папку WebView2, а значит и один
  // процесс движка — его владелец тот, кто открылся первым. tauri dev при пересборке убивает своё дерево
  // процессов вместе с движком, и у установленной копии остаётся чёрное окно. Отладочной сборке — своя папка.
  #[cfg(debug_assertions)]
  if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
      // SAFETY: в самом начале run(), до любых потоков
      unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", std::path::Path::new(&base).join("com.clipforge.app.dev")) };
    }
  }

  tauri::Builder::default()
    // вторая копия (ярлык, пока clipforge в трее) не запускается, а показывает окно первой.
    // Плагин регистрируется первым, чтобы вторая копия вышла раньше всего остального
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
    .plugin(tauri_plugin_dialog::init())
    // автообновление из релизов GitHub (latest.json) и перезапуск после установки
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![
      render::parse_demo,
      render::start_render,
      render::detect_gpu_encoder,
      render::parse_hud,
      render::parse_cam,
      render::parse_cine,
      render::demo_info,
      render::compare_list,
      render::grab_frame,
      render::faceit_levels,
      render::save_file,
      render::cs2_running,
      render::close_cs2,
      render::cancel_render,
      render::last_render,
      montage::build_montage,
      music::track_info,
      music::locate_hlae,
      music::read_audio,
      music::track_beats,
      music::track_env,
      music::lyrics_search,
      sky::install_sky,
      skins::scan_items,
      skins::rewrite_skins,
      ffmpeg::ffmpeg_status,
      ffmpeg::ensure_ffmpeg,
      hlae::ensure_hlae,
      reshade::reshade_status,
      reshade::ensure_reshade,
      gallery::list_clips,
      gallery::clip_thumb,
      gallery::reveal_clip,
      gallery::trash_clip,
      gallery::list_replays,
      gallery::open_replays,
      gallery::demo_header,
      gallery::steam_users,
      whisper::track_words,
      toast::toast_data,
      toast::toast_close,
      toast::toast_open,
      gsi::gsi_install,
      gsi::gsi_home,
      gsi::steam_playtime,
      faceit::faceit_recent,
      faceit::faceit_open,
      faceit::faceit_import,
      profile::steam_profile,
      profile::faceit_profile,
      profile::open_profile_link,
      friends::steam_friends,
      tray::set_tray,
      tray::autostart_enabled,
      tray::set_autostart,
      preflight::preflight,
      preflight::system_info,
      display::ultra_check,
      valve::valve_recent,
      valve::valve_download
    ])
    // крестик прячет окно в трей (если так выбрано в настройках)
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        tray::on_close(window, api);
      }
    })
    .setup(|app| {
      // запись Cinematic RTX могла оборваться (вылет программы) — вернуть настройки видео CS2
      reshade::restore_video();
      // и разрешение экрана, если его поднимали для «Мега-качества» (display.rs)
      display::restore();
      // окно по умолчанию 1400×760 (tauri.conf.json), чтобы справа в шапке влезал живой статус;
      // на экране поменьше ужимаем до рабочей области (без панели задач), но не меньше минимума
      if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
        if let Ok(Some(m)) = w.current_monitor() {
          let sf = m.scale_factor();
          let area = m.work_area().size;
          let (aw, ah) = (area.width as f64 / sf, area.height as f64 / sf);
          let (cw, ch) = (1400f64.min(aw * 0.94).max(960.0), 760f64.min(ah * 0.92).max(540.0));
          if cw < 1400.0 || ch < 760.0 {
            let _ = w.set_size(tauri::LogicalSize::new(cw, ch));
            let _ = w.center();
          }
        }
      }
      // окно создаётся скрытым (tauri.conf.json): при автозапуске с Windows (--tray) так и остаётся в трее
      tray::setup(app.handle())?;
      if !tray::started_in_tray() {
        tray::show_main(app.handle());
      }
      // свой Node и скрипты разбора демок лежат в ресурсах установленной программы (scripts/bundle-parser.cjs)
      if let Ok(dir) = tauri::Manager::path(app).resource_dir() {
        render::set_parser_dir(dir.join("parser"));
        sky::set_sky_dir(dir.join("sky"));
      }
      // живые данные из игры: история матчей, закладки хайлайтов, итог сессии (gsi.rs)
      gsi::start(app.handle().clone());
      if cfg!(debug_assertions) {
        app.handle().plugin(  
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}