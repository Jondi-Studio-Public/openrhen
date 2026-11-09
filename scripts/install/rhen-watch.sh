#!/bin/sh
# Install rhen-watch @VERSION@ for this user on macOS: download the release archive, check its SHA-256 against
# the release's SHA256SUMS, unpack to a temporary folder, run `rhen-watch install`, delete the temporary folder.
#
# No administrator rights; refuses sudo. Touches nothing outside that temporary folder and rhen-watch's own
# per-user install (~/Applications/rhen-watch.app, a LaunchAgent for your user, and its data folder).
# The program is not notarised; `install` signs its own copy ad hoc, which is what macOS needs to run it.
# Run as: curl -fsSL <release>/install.sh | sh    Run again to upgrade.
#
# RHEN_WATCH_RELEASE_BASE replaces the download address (CI points it at a local folder with file://).
set -eu

# Everything is inside one function, called on the last line, so a download cut short runs nothing.
install_rhen_watch() {
  version='@VERSION@'
  base="${RHEN_WATCH_RELEASE_BASE:-https://github.com/Jondi-Studio-Public/openrhen/releases/download/rhen-watch-v$version}"
  # https only; a local folder (file://) only when the address was replaced on purpose.
  proto='=https'
  [ -z "${RHEN_WATCH_RELEASE_BASE:-}" ] || proto='=https,file'
  asset="rhen-watch-$version-macos-universal.tar.gz"

  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "this script was not stamped with a version (got '$version'); use the install.sh attached to a release" >&2; return 1 ;;
  esac
  [ "$(uname -s)" = Darwin ] || { echo "rhen-watch install.sh is for macOS; on Windows use install.ps1" >&2; return 1; }
  [ "$(id -u)" != 0 ] || { echo "run this as yourself, not with sudo" >&2; return 1; }

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/rhen-watch.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM

  echo "Downloading rhen-watch $version ..."
  curl -fsSL --proto "$proto" -o "$tmp/$asset" "$base/$asset"
  curl -fsSL --proto "$proto" -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"

  # sha256sum format: "<hash>  <name>" (a "*" before the name marks binary mode).
  expected=$(awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == a) { print $1; exit } }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || { echo "SHA256SUMS has no line for $asset" >&2; return 1; }
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
  if [ "$(printf %s "$actual" | tr 'A-F' 'a-f')" != "$(printf %s "$expected" | tr 'A-F' 'a-f')" ]; then
    echo "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed" >&2
    return 1
  fi
  echo "Checksum verified."

  mkdir "$tmp/unpacked"
  tar -xzf "$tmp/$asset" -C "$tmp/unpacked"
  [ -x "$tmp/unpacked/rhen-watch" ] || { echo "rhen-watch is missing from the archive" >&2; return 1; }

  "$tmp/unpacked/rhen-watch" install

  bin="$HOME/Applications/rhen-watch.app/Contents/MacOS/rhen-watch"
  echo ""
  echo "Installed rhen-watch $version to $HOME/Applications/rhen-watch.app (look for it in the menu bar)."
  echo "Report:     \"$bin\" report"
  echo "Stop it:    \"$bin\" stop"
  echo "Uninstall:  \"$bin\" uninstall      (add --purge to delete your data too)"
}

install_rhen_watch
