mod ffmpeg;
mod gallery;
mod montage;
mod music;
mod overlay;
mod render;
mod sky;
mod skins;
mod toast;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
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
      music::lyrics_search,
      sky::install_sky,
      skins::scan_items,
      skins::rewrite_skins,
      ffmpeg::ffmpeg_status,
      ffmpeg::ensure_ffmpeg,
      gallery::list_clips,
      gallery::clip_thumb,
      gallery::reveal_clip,
      gallery::trash_clip,
      gallery::list_replays,
      gallery::open_replays,
      toast::toast_data,
      toast::toast_close,
      toast::toast_open
    ])
    .setup(|app| {
      // свой Node и скрипты разбора демок лежат в ресурсах установленной программы (scripts/bundle-parser.cjs)
      if let Ok(dir) = tauri::Manager::path(app).resource_dir() {
        render::set_parser_dir(dir.join("parser"));
        sky::set_sky_dir(dir.join("sky"));
      }
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