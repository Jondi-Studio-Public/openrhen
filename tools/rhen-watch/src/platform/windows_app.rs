//! The settings window: `rhen-watchw.exe app` (also what the Start menu entry and the tray's "Open settings" run).
//!
//! It is a separate, short-lived process, so a fault in it can never stop the recorder. It talks to the agent only
//! through things the agent already offers: the agent's hidden window (a registered message for pause and resume),
//! the stop event (stop and restart), the run lock and the small state files in the data folder (what it shows), and
//! `run_task` or a detached `run` (start). It has no network code and sends nothing anywhere.
//!
//! The window is plain Win32 controls (no crate). Everything it decides is in `app_model` and `app_ops`, which are
//! tested on any OS; this file draws it and carries out what the buttons say. All database, lock file and
//! `schtasks.exe` work runs on one worker thread, so the window never freezes; the worker answers by queueing a
//! `Reply` and posting `WM_APP_REPLY`.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Controls::*;
use windows_sys::Win32::UI::HiDpi::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

use super::windows as win;
use super::windows_install as inst;
use crate::app_model::{
    self, AutostartIntent, AutostartState, KEEP_PRESETS, PRIVACY_LINE, RunState, SettingsPlan, autostart_intent, autostart_note,
    keep_label, overview,
};
use crate::app_ops::{self, AppsData, SettingsData};
use crate::runner::Control;

// ---- ids, messages, layout ----

const IDC_TAB: i32 = 100;
const IDC_HEADLINE: i32 = 110;
const IDC_DETAIL: i32 = 111;
const IDC_PAUSE: i32 = 112;
const IDC_STOP: i32 = 113;
const IDC_START: i32 = 114;
const IDC_PRIVACY: i32 = 115;
const IDC_REPORT_LABEL: i32 = 116;
const IDC_REPORT: i32 = 117;
const IDC_FOLDER: i32 = 118;
const IDC_STATUS_OVERVIEW: i32 = 119;
const IDC_APPS_INTRO: i32 = 120;
const IDC_APPS_LIST: i32 = 121;
const IDC_CATEGORY_LABEL: i32 = 122;
const IDC_CATEGORY: i32 = 123;
const IDC_SET: i32 = 124;
const IDC_STATUS_APPS: i32 = 125;
const IDC_RESTART_APPS: i32 = 126;
const IDC_REFRESH_APPS: i32 = 127;
const IDC_AUTOSTART: i32 = 130;
const IDC_AUTOSTART_NOTE: i32 = 131;
const IDC_KEEP_LABEL: i32 = 132;
const IDC_KEEP: i32 = 133;
const IDC_KEEP_NOTE: i32 = 134;
const IDC_IDLE_LABEL: i32 = 135;
const IDC_IDLE: i32 = 136;
const IDC_IDLE_NOTE: i32 = 137;
const IDC_APPLY: i32 = 138;
const IDC_RESTART_SETTINGS: i32 = 139;
const IDC_STATUS_SETTINGS: i32 = 140;

const TAB_OVERVIEW: i32 = 0;
const TAB_APPS: i32 = 1;
const TAB_SETTINGS: i32 = 2;
const EVERY_TAB: i32 = -1;
const TAB_NAMES: [&str; 3] = ["Overview", "Apps", "Settings"];

const WM_APP_REPLY: u32 = WM_APP + 10;
/// `WM_USER`: the message `IsDialogMessageW` sends to ask for the default button, and its answer flag.
const DM_GETDEFID: u32 = WM_USER;
const DC_HASDEFID: u32 = 0x534b;
const POLL_TIMER: usize = 1;
const POLL_MS: u32 = 2000;
/// The report refreshes every this many polls while the Overview is showing (about 10 s).
const REPORT_EVERY_POLLS: u32 = 5;

const CLIENT_W: i32 = 640;
const CLIENT_H: i32 = 520;

#[derive(Clone, Copy, PartialEq)]
enum FontKind {
    Normal,
    Headline,
    Mono,
}

/// One control: where it lives (in 96-dpi units), which tab shows it and how it is made.
struct Ctl {
    id: i32,
    tab: i32,
    class: &'static str,
    text: &'static str,
    style: u32,
    ex_style: u32,
    rect: (i32, i32, i32, i32),
    font: FontKind,
}

fn ctl(id: i32, tab: i32, class: &'static str, text: &'static str, style: i32, rect: (i32, i32, i32, i32)) -> Ctl {
    Ctl {
        id,
        tab,
        class,
        text,
        style: style as u32,
        ex_style: 0,
        rect,
        font: FontKind::Normal,
    }
}

fn controls() -> Vec<Ctl> {
    let push = BS_PUSHBUTTON | WS_TABSTOP as i32;
    // SS_LEFT: left-aligned, wrapping text (the default static style, 0).
    let label = 0;
    let edit = ES_AUTOHSCROLL | WS_TABSTOP as i32;
    let combo = CBS_DROPDOWN | CBS_AUTOHSCROLL | WS_VSCROLL as i32 | WS_TABSTOP as i32;
    let mut v = vec![
        // The tab strip is only the header row; the page below it is the window's own face, so the controls on it
        // match whatever look the manifest gives them.
        ctl(
            IDC_TAB,
            EVERY_TAB,
            "SysTabControl32",
            "",
            WS_TABSTOP as i32 | WS_CLIPSIBLINGS as i32,
            (8, 8, 624, 28),
        ),
        // Overview
        Ctl {
            font: FontKind::Headline,
            ..ctl(IDC_HEADLINE, TAB_OVERVIEW, "STATIC", "", label, (16, 48, 608, 30))
        },
        ctl(IDC_DETAIL, TAB_OVERVIEW, "STATIC", "", label, (16, 80, 608, 40)),
        ctl(IDC_PAUSE, TAB_OVERVIEW, "BUTTON", "Pause recording", push, (16, 126, 150, 28)),
        ctl(IDC_STOP, TAB_OVERVIEW, "BUTTON", "Stop recording", push, (174, 126, 150, 28)),
        ctl(IDC_START, TAB_OVERVIEW, "BUTTON", "Start recording", push, (332, 126, 150, 28)),
        ctl(IDC_PRIVACY, TAB_OVERVIEW, "STATIC", PRIVACY_LINE, label, (16, 164, 608, 18)),
        ctl(IDC_REPORT_LABEL, TAB_OVERVIEW, "STATIC", "Today so far", label, (16, 190, 608, 18)),
        Ctl {
            font: FontKind::Mono,
            ex_style: WS_EX_CLIENTEDGE,
            ..ctl(
                IDC_REPORT,
                TAB_OVERVIEW,
                "EDIT",
                "",
                ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL as i32 | WS_TABSTOP as i32,
                (16, 210, 608, 250),
            )
        },
        ctl(IDC_FOLDER, TAB_OVERVIEW, "BUTTON", "Open data folder", push, (16, 472, 150, 28)),
        ctl(IDC_STATUS_OVERVIEW, TAB_OVERVIEW, "STATIC", "", label, (176, 478, 448, 36)),
        // Apps
        ctl(
            IDC_APPS_INTRO,
            TAB_APPS,
            "STATIC",
            "Apps with no category yet, longest in front first. Pick one, choose or type a category, and press Set. \
             The built-in app list is not changed; this writes your categories.toml.",
            label,
            (16, 48, 608, 40),
        ),
        Ctl {
            ex_style: WS_EX_CLIENTEDGE,
            ..ctl(
                IDC_APPS_LIST,
                TAB_APPS,
                "LISTBOX",
                "",
                LBS_NOTIFY | LBS_NOINTEGRALHEIGHT | WS_VSCROLL as i32 | WS_TABSTOP as i32,
                (16, 94, 608, 244),
            )
        },
        ctl(IDC_CATEGORY_LABEL, TAB_APPS, "STATIC", "Category:", label, (16, 354, 80, 20)),
        ctl(IDC_CATEGORY, TAB_APPS, "COMBOBOX", "", combo, (100, 350, 250, 200)),
        ctl(IDC_SET, TAB_APPS, "BUTTON", "Set", push, (360, 348, 90, 28)),
        ctl(IDC_STATUS_APPS, TAB_APPS, "STATIC", "", label, (16, 388, 608, 40)),
        ctl(IDC_RESTART_APPS, TAB_APPS, "BUTTON", "Restart recording", push, (16, 440, 170, 28)),
        ctl(IDC_REFRESH_APPS, TAB_APPS, "BUTTON", "Refresh list", push, (194, 440, 120, 28)),
        // Settings
        ctl(
            IDC_AUTOSTART,
            TAB_SETTINGS,
            "BUTTON",
            app_model::AUTOSTART_LABEL,
            BS_AUTO3STATE | WS_TABSTOP as i32,
            (16, 52, 300, 22),
        ),
        ctl(IDC_AUTOSTART_NOTE, TAB_SETTINGS, "STATIC", "", label, (36, 78, 588, 52)),
        ctl(IDC_KEEP_LABEL, TAB_SETTINGS, "STATIC", "Keep data:", label, (16, 146, 90, 20)),
        ctl(IDC_KEEP, TAB_SETTINGS, "COMBOBOX", "", combo, (110, 142, 160, 200)),
        ctl(
            IDC_KEEP_NOTE,
            TAB_SETTINGS,
            "STATIC",
            "Older recordings are deleted once a day.",
            label,
            (282, 146, 342, 20),
        ),
        ctl(
            IDC_IDLE_LABEL,
            TAB_SETTINGS,
            "STATIC",
            "Idle after (seconds):",
            label,
            (16, 188, 140, 20),
        ),
        ctl(IDC_IDLE, TAB_SETTINGS, "EDIT", "", edit | ES_NUMBER, (160, 184, 80, 24)),
        Ctl {
            ex_style: 0,
            ..ctl(
                IDC_IDLE_NOTE,
                TAB_SETTINGS,
                "STATIC",
                "No keyboard or mouse input for this long counts as idle.",
                label,
                (252, 188, 372, 20),
            )
        },
        ctl(IDC_APPLY, TAB_SETTINGS, "BUTTON", "Apply", push, (16, 236, 110, 28)),
        ctl(
            IDC_RESTART_SETTINGS,
            TAB_SETTINGS,
            "BUTTON",
            "Restart recording",
            push,
            (134, 236, 170, 28),
        ),
        ctl(IDC_STATUS_SETTINGS, TAB_SETTINGS, "STATIC", "", label, (16, 276, 608, 70)),
    ];
    for c in &mut v {
        c.ex_style |= 0;
    }
    v
}

// ---- messages between the window and the worker ----

enum Request {
    Poll,
    Report,
    Apps,
    Settings,
    Control(Control),
    Stop,
    Start,
    Restart(i32),
    SetCategory { exe: String, category: String },
    CheckApply { plan: SettingsPlan, intent: AutostartIntent },
    Apply { plan: SettingsPlan, intent: AutostartIntent },
}

/// What a successful action does to the "restart recording" prompt.
#[derive(Clone, Copy)]
enum Prompt {
    Keep,
    /// A setting changed that the running agent only reads at start.
    Raise,
    /// The agent was started afresh and has read everything.
    Clear,
}

enum Reply {
    State(RunState),
    Report(Result<String, String>),
    Apps(Result<AppsData, String>),
    Settings(Result<SettingsData, String>, AutostartState),
    /// An action ended: which status line to write to, what it does to the restart prompt when it worked, and the outcome.
    Done {
        status: i32,
        prompt: Prompt,
        result: Result<String, String>,
    },
    Confirm {
        question: Option<String>,
        plan: SettingsPlan,
        intent: AutostartIntent,
    },
}

static WORKER: OnceLock<Sender<Request>> = OnceLock::new();
static REPLIES: Mutex<Vec<Reply>> = Mutex::new(Vec::new());
static MAIN: AtomicIsize = AtomicIsize::new(0);
static POLL_PENDING: AtomicBool = AtomicBool::new(false);
static POLLS: AtomicU32 = AtomicU32::new(0);

fn main_hwnd() -> HWND {
    MAIN.load(Ordering::SeqCst) as HWND
}

fn ask(r: Request) {
    if let Some(tx) = WORKER.get() {
        let _ = tx.send(r);
    }
}

fn reply(r: Reply) {
    REPLIES.lock().unwrap_or_else(|e| e.into_inner()).push(r);
    unsafe { PostMessageW(main_hwnd(), WM_APP_REPLY, 0, 0) };
}

fn now_ms() -> i64 {
    crate::cli::now_ms()
}

/// What the window can see of the agent right now (touches the run lock briefly and looks for the agent's window).
fn poll(dir: &Path) -> RunState {
    let facts = app_ops::read_facts(dir, crate::cli::agent_running(dir), win::find_agent_window(dir) != 0);
    app_model::resolve_state(&facts)
}

/// After a pause or resume request: wait up to 5 s for the agent to have done it (it acts on its next tick).
fn wait_for(dir: &Path, c: Control) -> Result<(), String> {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let state = poll(dir);
        let done = match c {
            Control::Pause => state == RunState::Paused,
            Control::Resume => matches!(state, RunState::Recording | RunState::Degraded),
        };
        if done {
            return Ok(());
        }
        if std::time::Instant::now() >= until {
            return Err("the agent did not confirm within 5 seconds".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

/// Which status line an action reports to; `None` for the background reads (poll, report, lists).
fn home_status(r: &Request) -> Option<i32> {
    match r {
        Request::Control(_) | Request::Stop | Request::Start => Some(TAB_OVERVIEW),
        Request::Restart(status) => Some(*status),
        Request::SetCategory { .. } => Some(TAB_APPS),
        Request::CheckApply { .. } | Request::Apply { .. } => Some(TAB_SETTINGS),
        Request::Poll | Request::Report | Request::Apps | Request::Settings => None,
    }
}

/// One request at a time. A panic inside one is caught here so the window never stays busy for ever: an action
/// answers with an error, a background read just lets the next poll through.
fn worker(rx: Receiver<Request>, dir: PathBuf) {
    while let Ok(req) = rx.recv() {
        let status = home_status(&req);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(req, &dir))).is_err() {
            crate::log::error("internal error (panic) in the settings window's worker");
            POLL_PENDING.store(false, Ordering::SeqCst);
            if let Some(status) = status {
                reply(Reply::Done {
                    status,
                    prompt: Prompt::Keep,
                    result: Err("internal error; see rhen-watch.log in the data folder".into()),
                });
            }
        }
    }
}

fn handle(req: Request, dir: &Path) {
    // An action's outcome: refresh the state first, so the buttons are right when the message appears.
    let done = |status: i32, prompt: Prompt, result: Result<String, String>| {
        reply(Reply::State(poll(dir)));
        reply(Reply::Done { status, prompt, result });
    };
    {
        match req {
            Request::Poll => {
                reply(Reply::State(poll(dir)));
                POLL_PENDING.store(false, Ordering::SeqCst);
            }
            Request::Report => reply(Reply::Report(app_ops::report_text(dir, now_ms()))),
            Request::Apps => reply(Reply::Apps(app_ops::load_apps(dir))),
            Request::Settings => reply(Reply::Settings(app_ops::load_settings(dir), inst::autostart_state())),
            Request::Control(c) => {
                let r = win::send_control(dir, c).and_then(|()| wait_for(dir, c)).map(|()| {
                    match c {
                        Control::Pause => "Paused. Nothing is recorded until you resume.",
                        Control::Resume => "Recording again.",
                    }
                    .to_string()
                });
                done(TAB_OVERVIEW, Prompt::Keep, r);
            }
            Request::Stop => {
                let r = inst::stop_and_wait().map(|()| "Stopped. It stays stopped until you start it or log on again.".to_string());
                done(TAB_OVERVIEW, Prompt::Keep, r);
            }
            Request::Start => {
                let r = inst::start_agent(dir).map(|()| "Recording.".to_string());
                done(TAB_OVERVIEW, Prompt::Clear, r);
            }
            Request::Restart(status) => {
                let r = inst::restart_agent(dir).map(|()| "Recording restarted with the new settings.".to_string());
                done(status, Prompt::Clear, r);
            }
            Request::SetCategory { exe, category } => {
                let r = app_ops::set_category(dir, &exe, &category);
                let prompt = if r.is_ok() { Prompt::Raise } else { Prompt::Keep };
                done(TAB_APPS, prompt, r);
                reply(Reply::Apps(app_ops::load_apps(dir)));
            }
            Request::CheckApply { plan, intent } => {
                let question = app_ops::retention_question(dir, plan.keep, now_ms());
                match question {
                    Ok(question) => reply(Reply::Confirm { question, plan, intent }),
                    Err(e) => done(TAB_SETTINGS, Prompt::Keep, Err(e)),
                }
            }
            Request::Apply { plan, intent } => {
                let (saved, r) = apply(dir, &plan, intent);
                done(TAB_SETTINGS, if saved { Prompt::Raise } else { Prompt::Keep }, r);
                reply(Reply::Settings(app_ops::load_settings(dir), inst::autostart_state()));
            }
        }
    }
}

/// Save the settings, then change start-up if the box asked for it. The settings are validated and written first, so
/// a bad value never leaves start-up half changed. The flag says whether the settings file was written.
fn apply(dir: &Path, plan: &SettingsPlan, intent: AutostartIntent) -> (bool, Result<String, String>) {
    let mut message = match app_ops::apply_settings(dir, plan) {
        Ok(m) => m,
        Err(e) => return (false, Err(e)),
    };
    let startup = match intent {
        AutostartIntent::Unchanged => return (true, Ok(message)),
        AutostartIntent::Enable => inst::installed_gui()
            .and_then(|gui| inst::enable_autostart(&gui, dir, false))
            .map(|a| match a.reason() {
                None => "Start with Windows is on; it is restarted if it crashes.".to_string(),
                Some(why) => format!("Start with Windows is on, without restart after a crash ({why})."),
            }),
        AutostartIntent::Disable => inst::disable_autostart().map(|()| {
            "Start with Windows is off, and so is the restart after a crash. rhen-watch stays closed after you log off until you open it."
                .to_string()
        }),
    };
    match startup {
        Ok(line) => {
            message.push(' ');
            message.push_str(&line);
            (true, Ok(message))
        }
        Err(e) => (true, Err(format!("Settings saved, but start-up could not be changed: {e}"))),
    }
}

// ---- window state (the UI thread only) ----

struct Ui {
    dpi: u32,
    fonts: [HFONT; 3],
    tab: i32,
    state: RunState,
    busy: bool,
    /// The close button was pressed mid-action: the window closes when the action ends.
    closing: bool,
    restart_pending: bool,
    autostart: AutostartState,
    apps: Vec<crate::app_model::AppRow>,
    last_report: String,
    icon_shown: Option<crate::tray::TrayIcon>,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

/// Run `f` on the window state. Never call into Win32 inside `f`: a message it sends could come back into the window
/// procedure while the state is borrowed.
fn with_ui<T>(f: impl FnOnce(&mut Ui) -> T) -> Option<T> {
    UI.with(|u| u.borrow_mut().as_mut().map(f))
}

// ---- small control helpers ----

fn item(id: i32) -> HWND {
    unsafe { GetDlgItem(main_hwnd(), id) }
}

fn set_text(id: i32, text: &str) {
    unsafe { SetWindowTextW(item(id), win::wide(text).as_ptr()) };
}

fn get_text(id: i32) -> String {
    unsafe {
        let h = item(id);
        let len = GetWindowTextLengthW(h).max(0) as usize;
        let mut buf = vec![0u16; len + 1];
        let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
        String::from_utf16_lossy(&buf[..n])
    }
}

fn enable(id: i32, on: bool) {
    unsafe { EnableWindow(item(id), i32::from(on)) };
}

fn send(id: i32, msg: u32, w: usize, l: isize) -> isize {
    unsafe { SendMessageW(item(id), msg, w, l) }
}

fn is_visible_style(id: i32) -> bool {
    unsafe { GetWindowLongW(item(id), GWL_STYLE) as u32 & WS_VISIBLE != 0 }
}

fn scale(v: i32, dpi: u32) -> i32 {
    (v * dpi as i32 + 48) / 96
}

// ---- building the window ----

unsafe fn make_fonts(dpi: u32) -> [HFONT; 3] {
    unsafe {
        let mut ncm: NONCLIENTMETRICSW = std::mem::zeroed();
        ncm.cbSize = std::mem::size_of::<NONCLIENTMETRICSW>() as u32;
        if SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, ncm.cbSize, &mut ncm as *mut _ as *mut _, 0, dpi) == 0 {
            // Fall back to a 9 pt face scaled for the dpi.
            ncm.lfMessageFont.lfHeight = -scale(12, dpi);
        }
        let normal = ncm.lfMessageFont;
        let mut headline = normal;
        headline.lfHeight = normal.lfHeight * 3 / 2;
        headline.lfWeight = FW_BOLD as i32;
        let mut mono = normal;
        mono.lfFaceName = [0; 32];
        for (i, c) in "Consolas".encode_utf16().enumerate() {
            mono.lfFaceName[i] = c;
        }
        [
            CreateFontIndirectW(&normal),
            CreateFontIndirectW(&headline),
            CreateFontIndirectW(&mono),
        ]
    }
}

fn font_index(k: FontKind) -> usize {
    match k {
        FontKind::Normal => 0,
        FontKind::Headline => 1,
        FontKind::Mono => 2,
    }
}

/// Move and re-font every control for a dpi.
unsafe fn layout(dpi: u32, fonts: &[HFONT; 3]) {
    unsafe {
        for c in controls() {
            let (x, y, w, h) = c.rect;
            let hwnd = item(c.id);
            MoveWindow(hwnd, scale(x, dpi), scale(y, dpi), scale(w, dpi), scale(h, dpi), 1);
            SendMessageW(hwnd, WM_SETFONT, fonts[font_index(c.font)] as usize, 1);
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xffff) as i32;
            let code = ((wparam >> 16) & 0xffff) as u32;
            on_command(id, code);
            0
        }
        WM_NOTIFY => {
            let nm = unsafe { &*(lparam as *const NMHDR) };
            if nm.idFrom == IDC_TAB as usize && nm.code == TCN_SELCHANGE {
                let tab = send(IDC_TAB, TCM_GETCURSEL, 0, 0) as i32;
                select_tab(tab);
            }
            0
        }
        WM_TIMER if wparam == POLL_TIMER => {
            if !POLL_PENDING.swap(true, Ordering::SeqCst) {
                ask(Request::Poll);
            }
            let n = POLLS.fetch_add(1, Ordering::SeqCst) + 1;
            if n.is_multiple_of(REPORT_EVERY_POLLS) && with_ui(|u| u.tab) == Some(TAB_OVERVIEW) {
                ask(Request::Report);
            }
            0
        }
        WM_APP_REPLY => {
            let replies: Vec<Reply> = std::mem::take(&mut *REPLIES.lock().unwrap_or_else(|e| e.into_inner()));
            for r in replies {
                on_reply(r);
            }
            0
        }
        WM_DPICHANGED => {
            let dpi = (wparam & 0xffff) as u32;
            let suggested = unsafe { &*(lparam as *const RECT) };
            unsafe {
                let fonts = make_fonts(dpi);
                let old = with_ui(|u| {
                    u.dpi = dpi;
                    std::mem::replace(&mut u.fonts, fonts)
                });
                layout(dpi, &fonts);
                for f in old.into_iter().flatten() {
                    DeleteObject(f as _);
                }
                SetWindowPos(
                    hwnd,
                    null_mut(),
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            0
        }
        WM_CLOSE => {
            // Finish the current step first (a half-done stop, start or save is worse than a short wait).
            let busy = with_ui(|u| {
                u.closing = u.busy;
                u.busy
            });
            if busy != Some(true) {
                unsafe { DestroyWindow(hwnd) };
            }
            0
        }
        // Enter in a tab with a primary action presses it (IsDialogMessageW asks for the default button).
        DM_GETDEFID => {
            let id = match with_ui(|u| u.tab) {
                Some(TAB_APPS) => IDC_SET,
                Some(TAB_SETTINGS) => IDC_APPLY,
                _ => return 0,
            };
            (DC_HASDEFID << 16) as isize | id as isize
        }
        WM_DESTROY => {
            unsafe {
                KillTimer(hwnd, POLL_TIMER);
                PostQuitMessage(0);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn on_command(id: i32, code: u32) {
    let clicked = code == BN_CLICKED;
    match id {
        IDC_PAUSE if clicked => {
            let c = if with_ui(|u| u.state == RunState::Paused) == Some(true) {
                Control::Resume
            } else {
                Control::Pause
            };
            begin(Request::Control(c));
        }
        IDC_STOP if clicked => begin(Request::Stop),
        IDC_START if clicked => begin(Request::Start),
        IDC_FOLDER if clicked => open_data_folder(),
        IDC_RESTART_APPS if clicked => begin(Request::Restart(TAB_APPS)),
        IDC_RESTART_SETTINGS if clicked => begin(Request::Restart(TAB_SETTINGS)),
        IDC_REFRESH_APPS if clicked => ask(Request::Apps),
        IDC_SET if clicked => set_category(),
        IDC_APPLY if clicked => apply_settings(),
        IDC_AUTOSTART if clicked => {
            // A box that is not half-set only toggles between on and off, never the third state.
            let partial = with_ui(|u| matches!(u.autostart, AutostartState::Partial(_))).unwrap_or(false);
            if !partial && send(IDC_AUTOSTART, BM_GETCHECK, 0, 0) as u32 == BST_INDETERMINATE {
                send(IDC_AUTOSTART, BM_SETCHECK, BST_UNCHECKED as usize, 0);
            }
            refresh_autostart_note();
        }
        _ => {}
    }
}

/// An action that changes things: nothing else can be pressed until it ends.
fn begin(r: Request) {
    with_ui(|u| u.busy = true);
    refresh_buttons();
    ask(r);
}

fn open_data_folder() {
    let Ok(dir) = crate::cli::dir() else { return };
    // explorer.exe needs no COM setup on this thread, unlike ShellExecute.
    if let Ok(explorer) = win::system_path("explorer.exe", true) {
        let _ = std::process::Command::new(explorer)
            .arg(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

fn set_category() {
    let sel = send(IDC_APPS_LIST, LB_GETCURSEL, 0, 0);
    let exe = with_ui(|u| usize::try_from(sel).ok().and_then(|i| u.apps.get(i)).map(|r| r.exe.clone())).flatten();
    let category = get_text(IDC_CATEGORY).trim().to_string();
    match exe {
        None => set_text(IDC_STATUS_APPS, "Pick an app in the list first."),
        Some(_) if category.is_empty() => set_text(IDC_STATUS_APPS, "Choose or type a category first."),
        Some(exe) => {
            set_text(IDC_STATUS_APPS, "");
            begin(Request::SetCategory { exe, category });
        }
    }
}

fn autostart_choice() -> Option<bool> {
    match send(IDC_AUTOSTART, BM_GETCHECK, 0, 0) as u32 {
        BST_CHECKED => Some(true),
        BST_UNCHECKED => Some(false),
        _ => None,
    }
}

fn apply_settings() {
    let plan = match app_model::plan_settings(&get_text(IDC_KEEP), &get_text(IDC_IDLE)) {
        Ok(p) => p,
        Err(e) => {
            set_text(IDC_STATUS_SETTINGS, &e);
            return;
        }
    };
    let intent = with_ui(|u| autostart_choice().map_or(AutostartIntent::Unchanged, |c| autostart_intent(&u.autostart, c)))
        .unwrap_or(AutostartIntent::Unchanged);
    set_text(IDC_STATUS_SETTINGS, "");
    begin(Request::CheckApply { plan, intent });
}

fn refresh_autostart_note() {
    let note = with_ui(|u| match autostart_choice() {
        Some(checked) => autostart_note(&u.autostart, checked),
        None => autostart_note(&u.autostart, false).replace("Turned off when you press Apply", "Not changed"),
    });
    if let Some(note) = note {
        set_text(IDC_AUTOSTART_NOTE, &note);
    }
}

fn select_tab(tab: i32) {
    select_tab_visibility(tab);
    match tab {
        TAB_OVERVIEW => ask(Request::Report),
        TAB_APPS => ask(Request::Apps),
        _ => ask(Request::Settings),
    }
}

/// Everything that follows from the agent's state, busy flag and the restart prompt.
fn refresh_buttons() {
    let Some((state, busy, pending)) = with_ui(|u| (u.state.clone(), u.busy, u.restart_pending)) else {
        return;
    };
    let ov = overview(&state, busy);
    set_text(IDC_HEADLINE, &ov.headline);
    set_text(IDC_DETAIL, &ov.detail);
    for (id, b) in [(IDC_PAUSE, &ov.pause), (IDC_STOP, &ov.stop), (IDC_START, &ov.start)] {
        set_text(id, b.text);
        enable(id, b.enabled);
    }
    let can_restart = !busy && pending && state.is_running() && state != RunState::Unreachable;
    for id in [IDC_RESTART_APPS, IDC_RESTART_SETTINGS] {
        enable(id, can_restart);
    }
    enable(IDC_SET, !busy);
    enable(IDC_APPLY, !busy);
    // The window's icon follows the state, like the tray's.
    let icon = state.icon();
    if with_ui(|u| u.icon_shown.replace(icon)) != Some(Some(icon)) {
        set_window_icons(icon);
    }
}

fn set_window_icons(icon: crate::tray::TrayIcon) {
    unsafe {
        let hwnd = main_hwnd();
        let big = win::icon_handle(icon, GetSystemMetrics(SM_CXICON));
        let small = win::icon_handle(icon, GetSystemMetrics(SM_CXSMICON));
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, big as isize);
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, small as isize);
    }
}

fn fill_apps(data: &AppsData) {
    let keep_selected = send(IDC_APPS_LIST, LB_GETCURSEL, 0, 0);
    let previous = with_ui(|u| {
        usize::try_from(keep_selected)
            .ok()
            .and_then(|i| u.apps.get(i))
            .map(|r| r.exe.clone())
    })
    .flatten();
    send(IDC_APPS_LIST, WM_SETREDRAW, 0, 0);
    send(IDC_APPS_LIST, LB_RESETCONTENT, 0, 0);
    let mut select = None;
    for (i, row) in data.rows.iter().enumerate() {
        send(IDC_APPS_LIST, LB_ADDSTRING, 0, win::wide(&row.label()).as_ptr() as isize);
        if previous.as_deref() == Some(row.exe.as_str()) {
            select = Some(i);
        }
    }
    if let Some(i) = select {
        send(IDC_APPS_LIST, LB_SETCURSEL, i, 0);
    }
    send(IDC_APPS_LIST, WM_SETREDRAW, 1, 0);
    unsafe { InvalidateRect(item(IDC_APPS_LIST), null(), 1) };
    // The category box keeps what was typed while its list is rebuilt.
    let typed = get_text(IDC_CATEGORY);
    send(IDC_CATEGORY, CB_RESETCONTENT, 0, 0);
    for c in &data.categories {
        send(IDC_CATEGORY, CB_ADDSTRING, 0, win::wide(c).as_ptr() as isize);
    }
    set_text(IDC_CATEGORY, &typed);
    if data.rows.is_empty() {
        set_text(IDC_STATUS_APPS, "Every app seen so far has a category.");
    }
    with_ui(|u| u.apps = data.rows.clone());
}

fn fill_settings(data: &Result<SettingsData, String>, autostart: &AutostartState) {
    match data {
        Ok(d) => {
            set_text(IDC_KEEP, &keep_label(d.keep));
            set_text(IDC_IDLE, &d.idle_secs.to_string());
            enable(IDC_KEEP, true);
            enable(IDC_IDLE, true);
        }
        Err(e) => {
            // A broken config.toml is said, not replaced by defaults the file does not have.
            set_text(
                IDC_STATUS_SETTINGS,
                &format!("config.toml has a problem, so settings cannot be shown or saved: {e}"),
            );
            enable(IDC_KEEP, false);
            enable(IDC_IDLE, false);
        }
    }
    let check = match autostart {
        AutostartState::On(_) => BST_CHECKED,
        AutostartState::Off => BST_UNCHECKED,
        AutostartState::Partial(_) => BST_INDETERMINATE,
    };
    send(IDC_AUTOSTART, BM_SETCHECK, check as usize, 0);
    with_ui(|u| u.autostart = autostart.clone());
    refresh_autostart_note();
}

fn on_reply(r: Reply) {
    match r {
        Reply::State(s) => {
            with_ui(|u| u.state = s);
            refresh_buttons();
        }
        Reply::Report(text) => {
            let text = match text {
                Ok(t) => app_model::to_crlf(&t),
                Err(e) => format!("The report could not be read: {e}"),
            };
            if with_ui(|u| std::mem::replace(&mut u.last_report, text.clone())).as_deref() != Some(text.as_str()) {
                set_text(IDC_REPORT, &text);
            }
        }
        Reply::Apps(Ok(data)) => fill_apps(&data),
        Reply::Apps(Err(e)) => set_text(IDC_STATUS_APPS, &format!("The app list could not be read: {e}")),
        Reply::Settings(data, autostart) => fill_settings(&data, &autostart),
        Reply::Confirm { question, plan, intent } => {
            let go = question.is_none_or(|q| unsafe {
                MessageBoxW(
                    main_hwnd(),
                    win::wide(&q).as_ptr(),
                    win::wide("Delete older data?").as_ptr(),
                    MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
                ) == IDYES
            });
            if go {
                ask(Request::Apply { plan, intent });
            } else {
                with_ui(|u| u.busy = false);
                close_if_wanted();
                set_text(IDC_STATUS_SETTINGS, "Not saved.");
                refresh_buttons();
            }
        }
        Reply::Done { status, prompt, result } => {
            let id = match status {
                TAB_APPS => IDC_STATUS_APPS,
                TAB_SETTINGS => IDC_STATUS_SETTINGS,
                _ => IDC_STATUS_OVERVIEW,
            };
            let text = match &result {
                Ok(t) => t.clone(),
                Err(e) => format!("Problem: {e}"),
            };
            with_ui(|u| {
                u.busy = false;
                // Only an action that worked (or, for Apply, that saved the file) moves the prompt.
                match prompt {
                    Prompt::Raise => u.restart_pending = true,
                    Prompt::Clear if result.is_ok() => u.restart_pending = false,
                    _ => {}
                }
            });
            set_text(id, &text);
            refresh_buttons();
            close_if_wanted();
        }
    }
}

/// Close the window if the close button was pressed while an action ran and nothing runs now.
fn close_if_wanted() {
    if with_ui(|u| u.closing && !u.busy) == Some(true) {
        unsafe { DestroyWindow(main_hwnd()) };
    }
}

// ---- entry point ----

fn register_class() -> Result<(), String> {
    unsafe {
        let hinst = GetModuleHandleW(null());
        let class_name = win::wide(app_model::APP_WINDOW_CLASS);
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: hinst,
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: (COLOR_BTNFACE + 1) as HBRUSH,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassExW(&class) == 0 {
            return Err(format!("RegisterClassExW failed (error {})", GetLastError()));
        }
    }
    Ok(())
}

/// Create the window and all its controls, without showing it.
fn create_window() -> Result<(), String> {
    unsafe {
        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_TAB_CLASSES | ICC_STANDARD_CLASSES,
        };
        InitCommonControlsEx(&icc);
        register_class()?;
        let dpi = GetDpiForSystem().max(96);
        let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: scale(CLIENT_W, dpi),
            bottom: scale(CLIENT_H, dpi),
        };
        AdjustWindowRectExForDpi(&mut rect, style, 0, 0, dpi);
        let hinst = GetModuleHandleW(null());
        let hwnd = CreateWindowExW(
            0,
            win::wide(app_model::APP_WINDOW_CLASS).as_ptr(),
            win::wide("rhen-watch").as_ptr(),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            rect.right - rect.left,
            rect.bottom - rect.top,
            null_mut(),
            null_mut(),
            hinst,
            null(),
        );
        if hwnd.is_null() {
            return Err(format!("CreateWindowExW failed (error {})", GetLastError()));
        }
        MAIN.store(hwnd as isize, Ordering::SeqCst);
        let fonts = make_fonts(dpi);
        UI.with(|u| {
            *u.borrow_mut() = Some(Ui {
                dpi,
                fonts,
                tab: TAB_OVERVIEW,
                state: RunState::NotRunning,
                busy: false,
                closing: false,
                restart_pending: false,
                autostart: AutostartState::Off,
                apps: Vec::new(),
                last_report: String::new(),
                icon_shown: None,
            })
        });
        for c in controls() {
            let (x, y, w, h) = c.rect;
            let child = CreateWindowExW(
                c.ex_style,
                win::wide(c.class).as_ptr(),
                win::wide(c.text).as_ptr(),
                WS_CHILD | WS_VISIBLE | c.style,
                scale(x, dpi),
                scale(y, dpi),
                scale(w, dpi),
                scale(h, dpi),
                hwnd,
                c.id as isize as HMENU,
                hinst,
                null(),
            );
            if child.is_null() {
                return Err(format!("could not create control {} (error {})", c.id, GetLastError()));
            }
        }
        for (i, name) in TAB_NAMES.iter().enumerate() {
            let mut text = win::wide(name);
            let mut tci: TCITEMW = std::mem::zeroed();
            tci.mask = TCIF_TEXT;
            tci.pszText = text.as_mut_ptr();
            send(IDC_TAB, TCM_INSERTITEMW, i, &tci as *const _ as isize);
        }
        layout(dpi, &fonts);
        for p in KEEP_PRESETS {
            send(IDC_KEEP, CB_ADDSTRING, 0, win::wide(p).as_ptr() as isize);
        }
        select_tab_visibility(TAB_OVERVIEW);
        set_window_icons(crate::tray::TrayIcon::Recording);
    }
    Ok(())
}

/// Show only the controls of one tab (no data requests: the caller decides what to load).
fn select_tab_visibility(tab: i32) {
    with_ui(|u| u.tab = tab);
    for c in controls() {
        if c.tab != EVERY_TAB {
            unsafe { ShowWindow(item(c.id), if c.tab == tab { SW_SHOW } else { SW_HIDE }) };
        }
    }
}

/// Bring an already open settings window to the front (a second launch does this and exits).
fn focus(hwnd: isize) {
    unsafe {
        let h = hwnd as HWND;
        if IsIconic(h) != 0 {
            ShowWindow(h, SW_RESTORE);
        }
        SetForegroundWindow(h);
    }
}

/// `app --smoke`: build the window without showing it, fill it from the real data folder and read every control
/// back. Exits with an error naming the first thing that is wrong. For CI: it needs no desktop interaction.
fn smoke(dir: &Path) -> Result<(), String> {
    create_window()?;
    let result = (|| {
        let state = poll(dir);
        with_ui(|u| u.state = state.clone());
        refresh_buttons();
        for c in controls() {
            if item(c.id).is_null() {
                return Err(format!("control {} ({}) was not created", c.id, c.text));
            }
        }
        if send(IDC_TAB, TCM_GETITEMCOUNT, 0, 0) != TAB_NAMES.len() as isize {
            return Err("the tab strip does not have its three tabs".into());
        }
        if send(IDC_KEEP, CB_GETCOUNT, 0, 0) != KEEP_PRESETS.len() as isize {
            return Err("the Keep data box does not list its choices".into());
        }
        let ov = overview(&state, false);
        if get_text(IDC_HEADLINE) != ov.headline || get_text(IDC_PAUSE) != ov.pause.text || get_text(IDC_START) != ov.start.text {
            return Err(format!(
                "the Overview does not show the state ({state:?}): \"{}\"",
                get_text(IDC_HEADLINE)
            ));
        }
        if is_enabled(IDC_PAUSE) != ov.pause.enabled || is_enabled(IDC_START) != ov.start.enabled {
            return Err("the Overview buttons do not follow the state".into());
        }
        // Each tab shows its own controls and no others.
        for tab in [TAB_APPS, TAB_SETTINGS, TAB_OVERVIEW] {
            select_tab_visibility(tab);
            for c in controls() {
                let want = c.tab == EVERY_TAB || c.tab == tab;
                if is_visible_style(c.id) != want {
                    return Err(format!(
                        "control {} ({}) is {} on tab {tab}",
                        c.id,
                        c.text,
                        if want { "hidden" } else { "shown" }
                    ));
                }
            }
        }
        // The data behind the other two tabs loads, or says why not (a broken file is a message, not a crash).
        let apps = app_ops::load_apps(dir);
        if let Ok(data) = &apps {
            fill_apps(data);
            if send(IDC_APPS_LIST, LB_GETCOUNT, 0, 0) != data.rows.len() as isize {
                return Err("the Apps list does not hold the rows it was given".into());
            }
        }
        let settings = app_ops::load_settings(dir);
        fill_settings(&settings, &inst::autostart_state());
        if settings.is_ok() && (get_text(IDC_KEEP).is_empty() || get_text(IDC_IDLE).is_empty()) {
            return Err("the Settings tab did not show the saved values".into());
        }
        if get_text(IDC_AUTOSTART_NOTE).is_empty() {
            return Err("the start-up note is empty".into());
        }
        Ok(())
    })();
    unsafe { DestroyWindow(main_hwnd()) };
    result
}

fn is_enabled(id: i32) -> bool {
    unsafe { IsWindowEnabled(item(id)) != 0 }
}

/// A named mutex taken before the window class exists closes the gap between two launches in quick succession (the
/// class lookup alone can miss a window that is still being built). The handle is kept until the process ends.
/// Returns true when another instance has it and its window has been brought to the front.
fn another_instance_holds_the_name() -> bool {
    unsafe {
        let mutex = CreateMutexW(null(), 0, win::wide("Local\\rhen-watch-app").as_ptr());
        if mutex.is_null() || GetLastError() != ERROR_ALREADY_EXISTS {
            return false;
        }
        // The first instance may still be building its window: give it a moment. If none shows up it is
        // dying or stuck, so carry on and open our own.
        for _ in 0..12 {
            let open = win::app_window();
            if open != 0 {
                focus(open);
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        false
    }
}

/// Run the settings window until it is closed. `smoke` builds it hidden, checks it and returns (see `smoke`).
pub fn run(smoke_only: bool) -> Result<(), String> {
    let dir = crate::cli::dir()?;
    if !smoke_only {
        // One window: a second launch brings the first to the front.
        let open = win::app_window();
        if open != 0 {
            focus(open);
            return Ok(());
        }
    }
    if !smoke_only && another_instance_holds_the_name() {
        return Ok(());
    }
    unsafe { SetCurrentProcessExplicitAppUserModelID(win::wide(app_model::APP_USER_MODEL_ID).as_ptr()) };
    if smoke_only {
        return smoke(&dir);
    }
    create_window()?;
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = WORKER.set(tx);
    let worker_dir = dir.clone();
    std::thread::Builder::new()
        .name("rhen-watch-app-worker".into())
        .spawn(move || worker(rx, worker_dir))
        .map_err(|e| e.to_string())?;
    unsafe {
        let hwnd = main_hwnd();
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetTimer(hwnd, POLL_TIMER, POLL_MS, None);
    }
    POLL_PENDING.store(true, Ordering::SeqCst);
    ask(Request::Poll);
    ask(Request::Report);
    ask(Request::Settings);
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            if IsDialogMessageW(main_hwnd(), &msg) == 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    let fonts = with_ui(|u| u.fonts);
    for f in fonts.into_iter().flatten() {
        unsafe { DeleteObject(f as _) };
    }
    Ok(())
}
