// Уведомление «хайлайт готов» в правом нижнем углу экрана — своё окно в стиле приложения
// (системные уведомления Windows почти не оформить). Фокус не забирает: можно быть в игре или другом окне.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "toast";
const W: f64 = 420.0;
const H: f64 = 168.0;
const MARGIN: f64 = 16.0;

#[derive(Serialize, Clone)]
pub struct ToastClip {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct ToastData {
    pub clips: Vec<ToastClip>,
    pub hlae: String,
    pub out: String,
}

// последнее уведомление: страница окна забирает его сама, когда загрузится (событие могло прийти раньше)
static DATA: Mutex<Option<ToastData>> = Mutex::new(None);

pub fn show(app: &AppHandle, data: ToastData) {
    if data.clips.is_empty() { return; }
    // кадр-превью лежит в папке клипов — окну уведомления нужен к ней доступ, как вкладке «Хайлайты»
    let _ = app.asset_protocol_scope().allow_directory(&data.out, true);
    *DATA.lock().unwrap() = Some(data.clone());
    if let Some(win) = app.get_webview_window(LABEL) {
        // уже открыто — просто обновляем содержимое
        let _ = app.emit_to(LABEL, "toast-data", data);
        let _ = win.show();
        return;
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
        .title("clipforge")
        .inner_size(W, H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build();
    let Ok(win) = built else { return };
    // правый нижний угол рабочей области основного монитора (над панелью задач)
    if let Ok(Some(m)) = win.primary_monitor() {
        let s = m.scale_factor();
        let area = m.work_area();
        let (w, h) = ((W * s) as i32, (H * s) as i32);
        let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
        let _ = win.set_position(PhysicalPosition::new(
            area.position.x + area.size.width as i32 - w - (MARGIN * s) as i32,
            area.position.y + area.size.height as i32 - h - (MARGIN * s) as i32,
        ));
    }
    let _ = win.show();
}

#[tauri::command]
pub fn toast_data() -> Option<ToastData> {
    DATA.lock().unwrap().clone()
}

#[tauri::command]
pub fn toast_close(app: AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) { let _ = win.destroy(); }
}

// «Смотреть»: разворачиваем главное окно и открываем клип на вкладке «Хайлайты»
#[tauri::command]
pub fn toast_open(app: AppHandle, path: String) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit_to("main", "open-clip", path);
    toast_close(app);
}
