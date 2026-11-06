// Мини-режим в трее: крестик прячет окно, а clipforge остаётся в трее и дальше пишет статистику матчей
// (gsi.rs) и показывает уведомления. Пока окно спрятано, WebView ничего не рисует и не мешает игре.
// Ещё здесь автозапуск вместе с Windows (сразу в трей, флаг --tray).
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::render::no_window;

const TRAY_ID: &str = "main";
pub const TRAY_ARG: &str = "--tray";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "clipforge";

// крестик прячет в трей (настройка из интерфейса; по умолчанию — да)
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
// подсказку «clipforge в трее» показываем один раз за запуск
static HINT_SHOWN: AtomicBool = AtomicBool::new(false);

struct Items {
    show: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    show: String,
    quit: String,
    tip: String,
    hidden_title: String,
    hidden_sub: String,
}

static LABELS: Mutex<Option<Labels>> = Mutex::new(None);

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn started_in_tray() -> bool {
    std::env::args().any(|a| a == TRAY_ARG)
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    // подписи по-русски, пока интерфейс не прислал свои (set_tray) — он делает это сразу при запуске
    let show = MenuItem::with_id(app, "show", "Открыть clipforge", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("clipforge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(Items { show, quit });
    Ok(())
}

// Крестик главного окна: прячем в трей вместо выхода
pub fn on_close(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != "main" || !CLOSE_TO_TRAY.load(Ordering::SeqCst) { return; }
    api.prevent_close();
    let _ = window.hide();
    if !HINT_SHOWN.swap(true, Ordering::SeqCst) {
        if let Some(l) = LABELS.lock().unwrap().clone().filter(|l| !l.hidden_title.is_empty()) {
            crate::toast::note(window.app_handle(), crate::toast::ToastNote {
                tag: "clipforge".into(),
                title: l.hidden_title,
                sub: l.hidden_sub,
                action: "home".into(),
            });
        }
    }
}

#[tauri::command]
pub fn set_tray(app: AppHandle, close_to_tray: bool, labels: Labels) {
    CLOSE_TO_TRAY.store(close_to_tray, Ordering::SeqCst);
    if let Some(items) = app.try_state::<Items>() {
        let _ = items.show.set_text(&labels.show);
        let _ = items.quit.set_text(&labels.quit);
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&labels.tip));
    }
    *LABELS.lock().unwrap() = Some(labels);
}

fn reg(args: &[&str]) -> bool {
    let mut cmd = Command::new("reg");
    cmd.args(args);
    no_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[tauri::command]
pub async fn autostart_enabled() -> bool {
    reg(&["query", RUN_KEY, "/v", RUN_VALUE])
}

// Автозапуск: запись в HKCU\...\Run (без прав администратора), запуск сразу в трей
#[tauri::command]
pub async fn set_autostart(on: bool) -> Result<(), String> {
    let ok = if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let line = format!("\"{}\" {TRAY_ARG}", exe.display());
        reg(&["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &line, "/f"])
    } else {
        !reg(&["query", RUN_KEY, "/v", RUN_VALUE]) || reg(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
    };
    if ok { Ok(()) } else { Err("не удалось изменить автозапуск".into()) }
}
