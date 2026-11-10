//! The three generated icons (`assets/make_icons.py`) and a small reader for the `.ico` format, so the Windows
//! layer can hand one image of the right size to `CreateIconFromResourceEx` without a resource compiler.

use crate::tray::TrayIcon;

pub static RECORDING_ICO: &[u8] = include_bytes!("../assets/rhen-watch.ico");
pub static PAUSED_ICO: &[u8] = include_bytes!("../assets/rhen-watch-paused.ico");
pub static DEGRADED_ICO: &[u8] = include_bytes!("../assets/rhen-watch-degraded.ico");

/// The file written next to the installed program for the Start menu shortcut to point at.
pub const INSTALLED_ICON_FILE: &str = "rhen-watch.ico";

pub fn ico_for(icon: TrayIcon) -> &'static [u8] {
    match icon {
        TrayIcon::Recording => RECORDING_ICO,
        TrayIcon::Paused => PAUSED_ICO,
        TrayIcon::Degraded => DEGRADED_ICO,
    }
}

/// One image of an `.ico` file: its pixel size and its DIB bytes (what `CreateIconFromResourceEx` takes).
#[derive(Debug, PartialEq)]
pub struct IcoImage<'a> {
    pub width: u32,
    pub height: u32,
    pub bits: u16,
    pub dib: &'a [u8],
}

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

/// Every image in the file, or `None` if it is not a well-formed icon file.
pub fn images(ico: &[u8]) -> Option<Vec<IcoImage<'_>>> {
    if u16_at(ico, 0)? != 0 || u16_at(ico, 2)? != 1 {
        return None;
    }
    let count = usize::from(u16_at(ico, 4)?);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let e = 6 + 16 * i;
        let dim = |b: u8| if b == 0 { 256 } else { u32::from(b) };
        let (width, height) = (dim(*ico.get(e)?), dim(*ico.get(e + 1)?));
        let bits = u16_at(ico, e + 6)?;
        let size = u32_at(ico, e + 8)? as usize;
        let offset = u32_at(ico, e + 12)? as usize;
        out.push(IcoImage {
            width,
            height,
            bits,
            dib: ico.get(offset..offset.checked_add(size)?)?,
        });
    }
    Some(out)
}

/// The image to use for a wanted size: the smallest one at least that big, else the largest there is.
pub fn pick(ico: &[u8], want: u32) -> Option<IcoImage<'_>> {
    let mut all = images(ico)?;
    all.sort_by_key(|i| i.width);
    let at_least = all.iter().position(|i| i.width >= want);
    let index = at_least.unwrap_or(all.len().checked_sub(1)?);
    Some(all.swap_remove(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_has_16_32_and_48_pixel_32_bit_images_with_real_pixels() {
        for (name, ico) in [("recording", RECORDING_ICO), ("paused", PAUSED_ICO), ("degraded", DEGRADED_ICO)] {
            let all = images(ico).unwrap_or_else(|| panic!("{name} is not a valid icon file"));
            let sizes: Vec<u32> = all.iter().map(|i| i.width).collect();
            assert_eq!(sizes, [16, 32, 48], "{name}");
            for i in &all {
                assert_eq!((i.width, i.bits), (i.height, 32), "{name}: square and 32-bit");
                // BITMAPINFOHEADER: 40 bytes, height doubled for the mask, 32 bits per pixel.
                assert_eq!(u32_at(i.dib, 0), Some(40));
                assert_eq!(u32_at(i.dib, 8), Some(i.height * 2));
                assert!(
                    i.dib[40..].chunks(4).take((i.width * i.height) as usize).any(|px| px[3] == 255),
                    "{name}: the image has opaque pixels"
                );
            }
        }
    }

    #[test]
    fn the_three_icons_differ_and_each_state_has_its_own() {
        assert_ne!(RECORDING_ICO, PAUSED_ICO);
        assert_ne!(PAUSED_ICO, DEGRADED_ICO);
        assert_ne!(RECORDING_ICO, DEGRADED_ICO);
        assert_eq!(ico_for(TrayIcon::Paused), PAUSED_ICO);
        assert_eq!(ico_for(TrayIcon::Degraded), DEGRADED_ICO);
        assert_eq!(ico_for(TrayIcon::Recording), RECORDING_ICO);
    }

    #[test]
    fn pick_takes_the_smallest_image_that_is_big_enough() {
        let width = |want| pick(RECORDING_ICO, want).unwrap().width;
        assert_eq!(
            (width(16), width(20), width(32), width(40), width(48), width(256)),
            (16, 32, 32, 48, 48, 48)
        );
    }

    #[test]
    fn a_damaged_file_is_refused_not_misread() {
        assert!(images(&[]).is_none());
        assert!(images(&RECORDING_ICO[..40]).is_none(), "image data cut short");
        assert!(images(&[0, 0, 2, 0, 1, 0]).is_none(), "a cursor file is not an icon");
    }
}
