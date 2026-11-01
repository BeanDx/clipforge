// Подсказка поверх окна CS2 во время рендера: «нажми F10, чтобы начать запись», потом ход записи.
// Это отдельное прозрачное окно программы поверх игры. HLAE пишет кадры из движка игры, а не с экрана,
// поэтому подсказка в клип не попадает. Окно не забирает фокус и пропускает клики — клавиша уходит в игру.
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "overlay";
const W: u32 = 760;
const H: u32 = 120;

#[derive(Serialize, Clone)]
pub struct OverlayState {
    pub phase: &'static str, // "wait" — ждём клавишу, "rec" — идёт запись, "done" — запись готова
    pub key: String,
    pub clip: usize,
    pub total: usize,
    pub pct: f32,
}

// Прямоугольник клиентской части окна CS2 в экранных пикселях
#[cfg(windows)]
fn cs2_rect() -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetClientRect, GetForegroundWindow, IsIconic};
    let title: Vec<u16> = "Counter-Strike 2".encode_utf16().chain(Some(0)).collect();
    unsafe {
        let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
        // игра свёрнута или ты переключился в другое окно — подсказка не должна висеть поверх него
        if hwnd.is_null() || IsIconic(hwnd) != 0 || GetForegroundWindow() != hwnd { return None; }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetClientRect(hwnd, &mut r) == 0 { return None; }
        let mut p = POINT { x: 0, y: 0 };
        ClientToScreen(hwnd, &mut p);
        Some((p.x, p.y, r.right - r.left, r.bottom - r.top))
    }
}
#[cfg(not(windows))]
fn cs2_rect() -> Option<(i32, i32, i32, i32)> { None }

// Показывает подсказку (создаёт окно при первом вызове) над верхним краем игры по центру.
// Без окна игры — прячем: значит, игра ещё не открылась или свёрнута.
pub fn show(app: &AppHandle, state: OverlayState) {
    let Some((x, y, w, _)) = cs2_rect() else { hide(app); return };
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => {
            let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
                .title("clipforge")
                .inner_size(W as f64, H as f64)
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
            let _ = win.set_ignore_cursor_events(true);
            win
        }
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let (pw, ph) = ((W as f64 * scale) as i32, (H as f64 * scale) as i32);
    let _ = win.set_size(PhysicalSize::new(pw as u32, ph as u32));
    let _ = win.set_position(PhysicalPosition::new(x + (w - pw) / 2, y + (24.0 * scale) as i32));
    if !win.is_visible().unwrap_or(false) { let _ = win.show(); }
    let _ = app.emit_to(LABEL, "overlay-state", state);
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) { let _ = win.hide(); }
}

pub fn close(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) { let _ = win.destroy(); }
}
