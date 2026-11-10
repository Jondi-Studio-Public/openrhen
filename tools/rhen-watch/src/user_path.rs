//! Editing the user's `PATH` value as text, so `rhen-watch` works from a new PowerShell without a full path.
//! Pure string work (the registry and the broadcast are in `platform::windows`), tested on any OS. The value is a
//! `;`-separated list; entries other than ours are never rewritten, reordered or expanded (`%USERPROFILE%\bin` stays
//! exactly as typed), and the registry type is the caller's to keep.

/// How two spellings of a folder compare: ignoring case, surrounding spaces and trailing backslashes or slashes.
fn key(entry: &str) -> String {
    entry.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase()
}

/// True when `entry` is one of `spellings` (the folder as an absolute path, and as the unexpanded variable form).
fn is_ours(entry: &str, spellings: &[&str]) -> bool {
    let e = key(entry);
    !e.is_empty() && spellings.iter().any(|s| key(s) == e)
}

pub fn contains(value: &str, spellings: &[&str]) -> bool {
    value.split(';').any(|e| is_ours(e, spellings))
}

/// The value with `dir` appended, or `None` when an entry for it is already there (so nothing is written).
/// A missing or blank value becomes just `dir`; a value ending in `;` gets no doubled separator.
pub fn add(value: &str, dir: &str, spellings: &[&str]) -> Option<String> {
    if contains(value, spellings) {
        return None;
    }
    Some(if value.trim().is_empty() {
        dir.to_string()
    } else if value.ends_with(';') {
        format!("{value}{dir}")
    } else {
        format!("{value};{dir}")
    })
}

/// The value without our entry (every spelling of it), or `None` when it is not there. Other entries, including
/// empty ones, stay as they were.
pub fn remove(value: &str, spellings: &[&str]) -> Option<String> {
    if !contains(value, spellings) {
        return None;
    }
    let kept: Vec<&str> = value.split(';').filter(|e| !is_ours(e, spellings)).collect();
    Some(kept.join(";"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = r"C:\Users\Ann\AppData\Local\Programs\rhen-watch";
    const VAR: &str = r"%LOCALAPPDATA%\Programs\rhen-watch";
    const S: [&str; 2] = [DIR, VAR];

    #[test]
    fn an_absent_folder_is_appended_after_what_is_there() {
        assert_eq!(add(r"C:\a;C:\b", DIR, &S).unwrap(), format!(r"C:\a;C:\b;{DIR}"));
        assert_eq!(add(r"C:\a;", DIR, &S).unwrap(), format!(r"C:\a;{DIR}"), "no doubled separator");
    }

    #[test]
    fn a_missing_or_blank_value_becomes_just_the_folder() {
        assert_eq!(add("", DIR, &S).unwrap(), DIR);
        assert_eq!(add("  ", DIR, &S).unwrap(), DIR);
    }

    #[test]
    fn a_folder_already_there_changes_nothing_whatever_its_spelling() {
        for v in [
            format!(r"C:\a;{DIR}"),
            format!(r"{DIR};C:\a"),
            format!(r"C:\a;{DIR}\"),
            format!(r"C:\a;{DIR}/"),
            r"C:\a;c:\users\ann\appdata\local\programs\RHEN-WATCH".to_string(),
            format!(r"C:\a; {DIR} ;C:\b"),
            format!(r"C:\a;{VAR}"),
            format!(r"C:\a;{}\", VAR.to_ascii_lowercase()),
        ] {
            assert!(contains(&v, &S), "{v}");
            assert_eq!(add(&v, DIR, &S), None, "{v}");
        }
    }

    #[test]
    fn a_similar_folder_is_not_ours() {
        let v = format!(r"{DIR}-old;{DIR}\bin;C:\x\rhen-watch");
        assert!(!contains(&v, &S));
        assert_eq!(remove(&v, &S), None);
        assert!(add(&v, DIR, &S).unwrap().ends_with(&format!(";{DIR}")));
    }

    #[test]
    fn removal_takes_exactly_our_entry_and_keeps_every_other_one_untouched() {
        let others = r"%USERPROFILE%\bin;C:\Program Files\Git\cmd;;D:\tools\";
        let v = format!(r"{others};{DIR}");
        assert_eq!(
            remove(&v, &S).unwrap(),
            others,
            "an expand-string entry and an empty one survive as typed"
        );
        assert_eq!(remove(&format!(r"{DIR};C:\a"), &S).unwrap(), r"C:\a");
        assert_eq!(
            remove(&format!(r"C:\a;{DIR}\;C:\b"), &S).unwrap(),
            r"C:\a;C:\b",
            "trailing slash spelling"
        );
        assert_eq!(remove(&format!(r"C:\a;{VAR};C:\b"), &S).unwrap(), r"C:\a;C:\b", "variable spelling");
        assert_eq!(remove(DIR, &S).unwrap(), "", "ours alone leaves an empty value");
        assert_eq!(remove(r"C:\a;C:\b", &S), None, "absent: nothing to write");
        assert_eq!(remove("", &S), None);
    }

    #[test]
    fn add_then_remove_round_trips_and_a_second_add_is_a_no_op() {
        let original = r"%USERPROFILE%\bin;C:\Windows";
        let added = add(original, DIR, &S).unwrap();
        assert_eq!(add(&added, DIR, &S), None, "reinstall or upgrade");
        assert_eq!(remove(&added, &S).unwrap(), original);
        assert!(added.starts_with(original), "existing entries keep their place");
    }
}
