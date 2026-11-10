//! The Start menu shortcut, made with the shell's `IShellLinkW` and `IPersistFile` through hand-written vtables over
//! `windows-sys` (which has no COM interfaces, and the project takes no crate for it). This is the only COM code in
//! the program; it is small on purpose, every pointer it dereferences comes from the call that returned it, and
//! `install` reads the shortcut back to prove it points at the installed program.
//!
//! The vtable layouts are the documented method orders of the two interfaces (`shobjidl_core.h`, `objidl.h`).

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use windows_sys::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows_sys::Win32::UI::Shell::{FOLDERID_Programs, SHGetKnownFolderPath};
use windows_sys::core::{GUID, HRESULT};

use super::windows::wide;

const CLSID_SHELL_LINK: GUID = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);
const IID_ISHELL_LINK_W: GUID = GUID::from_u128(0x000214f9_0000_0000_c000_000000000046);
const IID_IPERSIST_FILE: GUID = GUID::from_u128(0x0000010b_0000_0000_c000_000000000046);

type Method = unsafe extern "system" fn();

#[repr(C)]
struct IUnknownVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

/// `IShellLinkW`, in declaration order. Methods this file never calls are kept as opaque slots so the ones after
/// them sit at the right offsets.
#[repr(C)]
struct IShellLinkWVtbl {
    base: IUnknownVtbl,
    get_path: unsafe extern "system" fn(*mut c_void, *mut u16, i32, *mut c_void, u32) -> HRESULT,
    get_id_list: Method,
    set_id_list: Method,
    get_description: Method,
    set_description: unsafe extern "system" fn(*mut c_void, *const u16) -> HRESULT,
    get_working_directory: Method,
    set_working_directory: unsafe extern "system" fn(*mut c_void, *const u16) -> HRESULT,
    get_arguments: unsafe extern "system" fn(*mut c_void, *mut u16, i32) -> HRESULT,
    set_arguments: unsafe extern "system" fn(*mut c_void, *const u16) -> HRESULT,
    get_hotkey: Method,
    set_hotkey: Method,
    get_show_cmd: Method,
    set_show_cmd: Method,
    get_icon_location: Method,
    set_icon_location: unsafe extern "system" fn(*mut c_void, *const u16, i32) -> HRESULT,
    set_relative_path: Method,
    resolve: Method,
    set_path: unsafe extern "system" fn(*mut c_void, *const u16) -> HRESULT,
}

/// `IPersistFile` (which starts with `IPersist::GetClassID`).
#[repr(C)]
struct IPersistFileVtbl {
    base: IUnknownVtbl,
    get_class_id: Method,
    is_dirty: Method,
    load: unsafe extern "system" fn(*mut c_void, *const u16, u32) -> HRESULT,
    save: unsafe extern "system" fn(*mut c_void, *const u16, i32) -> HRESULT,
    save_completed: Method,
    get_cur_file: Method,
}

/// A COM object pointer that is released when it goes out of scope.
struct Com<T> {
    ptr: *mut *const T,
}

impl<T> Com<T> {
    fn vtbl(&self) -> &T {
        // SAFETY: a COM interface pointer points at a pointer to its vtable, both valid until `Release`.
        unsafe { &**self.ptr }
    }

    fn raw(&self) -> *mut c_void {
        self.ptr.cast()
    }
}

impl<T> Drop for Com<T> {
    fn drop(&mut self) {
        // SAFETY: every interface starts with IUnknown, so `release` is at the same place in each vtable.
        unsafe {
            let unknown = &**(self.ptr as *mut *const IUnknownVtbl);
            (unknown.release)(self.ptr.cast());
        }
    }
}

/// COM on this thread for the life of the guard.
struct ComApartment(bool);

impl ComApartment {
    fn enter() -> Result<Self, String> {
        // SAFETY: plain initialisation call. S_FALSE (already initialised) still needs the matching uninitialise;
        // RPC_E_CHANGED_MODE means another model is in use on this thread, which the calls below can still use.
        let hr = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
        match hr {
            0 | 1 => Ok(Self(true)),
            h if h as u32 == 0x8001_0106 => Ok(Self(false)),
            h => Err(format!("COM did not start (0x{:08x})", h as u32)),
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful CoInitializeEx in `enter`.
            unsafe { CoUninitialize() };
        }
    }
}

fn check(hr: HRESULT, what: &str) -> Result<(), String> {
    if hr >= 0 {
        Ok(())
    } else {
        Err(format!("{what} failed (0x{:08x})", hr as u32))
    }
}

fn new_link() -> Result<Com<IShellLinkWVtbl>, String> {
    let mut out: *mut c_void = null_mut();
    // SAFETY: CLSID and IID are the documented ones, `out` receives an owned interface pointer on success.
    let hr = unsafe { CoCreateInstance(&CLSID_SHELL_LINK, null_mut(), CLSCTX_INPROC_SERVER, &IID_ISHELL_LINK_W, &mut out) };
    check(hr, "creating the shortcut object")?;
    Ok(Com { ptr: out.cast() })
}

fn persist_file(link: &Com<IShellLinkWVtbl>) -> Result<Com<IPersistFileVtbl>, String> {
    let mut out: *mut c_void = null_mut();
    // SAFETY: QueryInterface on a live interface pointer with the documented IID.
    let hr = unsafe { (link.vtbl().base.query_interface)(link.raw(), &IID_IPERSIST_FILE, &mut out) };
    check(hr, "asking the shortcut object to save")?;
    Ok(Com { ptr: out.cast() })
}

/// The folder Start menu entries of this user live in (`%APPDATA%\\...\\Start Menu\\Programs`), asked of the shell
/// rather than assembled, so a redirected profile is followed.
pub fn start_menu_programs_dir() -> Result<PathBuf, String> {
    let mut pwstr: *mut u16 = null_mut();
    // SAFETY: the shell allocates the string on success; it is read once and freed with CoTaskMemFree.
    unsafe {
        let hr = SHGetKnownFolderPath(&FOLDERID_Programs, 0, null_mut(), &mut pwstr);
        if hr < 0 || pwstr.is_null() {
            return Err(format!("could not find the Start menu folder (0x{:08x})", hr as u32));
        }
        let mut len = 0;
        while *pwstr.add(len) != 0 {
            len += 1;
        }
        let path = String::from_utf16_lossy(std::slice::from_raw_parts(pwstr, len));
        CoTaskMemFree(pwstr.cast());
        Ok(PathBuf::from(path))
    }
}

/// Create (or replace) the shortcut at `lnk`.
pub fn create(lnk: &Path, target: &Path, args: &str, work_dir: &Path, icon: &Path, description: &str) -> Result<(), String> {
    let _com = ComApartment::enter()?;
    let link = new_link()?;
    let v = link.vtbl();
    let w = |p: &Path| wide(&p.to_string_lossy());
    // SAFETY: each call is on the live interface with a NUL-terminated wide string that outlives the call.
    unsafe {
        check((v.set_path)(link.raw(), w(target).as_ptr()), "setting the shortcut target")?;
        check((v.set_arguments)(link.raw(), wide(args).as_ptr()), "setting the shortcut arguments")?;
        check(
            (v.set_working_directory)(link.raw(), w(work_dir).as_ptr()),
            "setting the shortcut folder",
        )?;
        check(
            (v.set_description)(link.raw(), wide(description).as_ptr()),
            "setting the shortcut description",
        )?;
        check((v.set_icon_location)(link.raw(), w(icon).as_ptr(), 0), "setting the shortcut icon")?;
        let file = persist_file(&link)?;
        check((file.vtbl().save)(file.raw(), w(lnk).as_ptr(), 1), "saving the shortcut")
    }
}

/// The target and arguments a shortcut file holds.
pub fn read(lnk: &Path) -> Result<(String, String), String> {
    let _com = ComApartment::enter()?;
    let link = new_link()?;
    // SAFETY: as in `create`; the buffers are sized for the lengths passed.
    unsafe {
        let file = persist_file(&link)?;
        check(
            (file.vtbl().load)(file.raw(), wide(&lnk.to_string_lossy()).as_ptr(), 0),
            "reading the shortcut",
        )?;
        let v = link.vtbl();
        let mut target = vec![0u16; 32_768];
        check(
            (v.get_path)(link.raw(), target.as_mut_ptr(), target.len() as i32, null_mut(), 0),
            "reading the shortcut target",
        )?;
        let mut args = vec![0u16; 32_768];
        check(
            (v.get_arguments)(link.raw(), args.as_mut_ptr(), args.len() as i32),
            "reading the shortcut arguments",
        )?;
        let text = |b: &[u16]| String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())]);
        Ok((text(&target), text(&args)))
    }
}
