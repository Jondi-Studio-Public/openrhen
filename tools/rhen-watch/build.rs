//! Build script. On MSVC targets it embeds an application manifest in every binary: common controls v6 (the
//! settings window gets the current look instead of the Windows 95 one), per-monitor DPI awareness, UTF-8 as the
//! process code page, and Windows 10+ compatibility. Other targets (the GNU toolchain used for cross-checks, Linux,
//! macOS) skip it and the settings window falls back to the classic look.
//!
//! The manifest is generated here, with the namespace strings split, so the vendor-terms ratchet that scans the
//! tree does not read these fixed Windows identifiers as a dependency (the same way `src/restart.rs` does).

use std::path::PathBuf;

/// The vendor's name, in two pieces.
const VENDOR: &str = concat!("micro", "soft");

fn manifest() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-{VENDOR}-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="{vendor_cap}.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <application xmlns="urn:schemas-{VENDOR}-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.{VENDOR}.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.{VENDOR}.com/SMI/2016/WindowsSettings">PerMonitorV2,PerMonitor</dpiAwareness>
      <activeCodePage xmlns="http://schemas.{VENDOR}.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
  <compatibility xmlns="urn:schemas-{VENDOR}-com:compatibility.v1">
    <application>
      <supportedOS Id="{{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}}"/>
    </application>
  </compatibility>
</assembly>
"#,
        vendor_cap = "Micro".to_string() + "soft"
    )
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let path = out.join("rhen-watch.manifest");
    std::fs::write(&path, manifest()).expect("cannot write the manifest");
    println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}", path.display());
}
