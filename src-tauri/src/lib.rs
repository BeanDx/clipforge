mod gallery;
mod music;
mod overlay;
mod render;
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
      music::track_info,
      music::locate_hlae,
      music::read_audio,
      music::lyrics_search,
      skins::scan_items,
      skins::rewrite_skins,
      gallery::list_clips,
      gallery::clip_thumb,
      gallery::reveal_clip,
      gallery::trash_clip,
      toast::toast_data,
      toast::toast_close,
      toast::toast_open
    ])
    .setup(|app| {
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