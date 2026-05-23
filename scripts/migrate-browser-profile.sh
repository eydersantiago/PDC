#!/usr/bin/env zsh
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/migrate-browser-profile.sh backup  <chrome|atlas|vscode|all> [output-dir]
  scripts/migrate-browser-profile.sh restore <archive.tar.gz>

Creates/restores a portable browser profile backup for migration between Macs.

The backup intentionally excludes live auth/session material such as cookies,
password stores, token databases, VS Code auth storage, and local keychain-backed
secrets. After restore, sign in again to sites, browser sync, and VS Code
accounts on the destination Mac.
USAGE
}

die() {
  print -u2 "Error: $*"
  exit 1
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "this script is intended for macOS."
}

app_support_dir() {
  case "$1" in
    chrome) print "$HOME/Library/Application Support/Google/Chrome" ;;
    atlas) print "$HOME/Library/Application Support/Atlas" ;;
    vscode) print "$HOME/Library/Application Support/Code" ;;
    *) die "unknown browser '$1'." ;;
  esac
}

archive_name() {
  local browser="$1"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  print "browser-profile-${browser}-${stamp}.tar.gz"
}

assert_browser_closed() {
  local browser="$1"
  local app_name
  case "$browser" in
    chrome) app_name="Google Chrome" ;;
    atlas) app_name="Atlas" ;;
    vscode) app_name="Visual Studio Code" ;;
    *) return 0 ;;
  esac

  if pgrep -x "$app_name" >/dev/null 2>&1; then
    die "$app_name is running. Quit it before backing up or restoring."
  fi
}

backup_one() {
  local browser="$1"
  local output_dir="$2"
  local source_dir
  local output_file

  source_dir="$(app_support_dir "$browser")"
  [[ -d "$source_dir" ]] || die "profile directory not found: $source_dir"

  assert_browser_closed "$browser"
  mkdir -p "$output_dir"
  output_file="$output_dir/$(archive_name "$browser")"

  tar -C "$(dirname "$source_dir")" \
    --exclude='*/Cookies' \
    --exclude='*/Cookies-journal' \
    --exclude='*/Login Data' \
    --exclude='*/Login Data-journal' \
    --exclude='*/Local State' \
    --exclude='*/Network/Cookies' \
    --exclude='*/Network/Cookies-journal' \
    --exclude='*/Session Storage' \
    --exclude='*/Sessions' \
    --exclude='*/Sync Data' \
    --exclude='*/Token Service' \
    --exclude='*/Web Data' \
    --exclude='*/Web Data-journal' \
    --exclude='*/Safe Browsing*' \
    --exclude='*/Crashpad' \
    --exclude='*/Code Cache' \
    --exclude='*/GPUCache' \
    --exclude='*/GrShaderCache' \
    --exclude='*/ShaderCache' \
    --exclude='*/BrowserMetrics*' \
    -czf "$output_file" \
    "$(basename "$source_dir")"

  print "Created: $output_file"
}

backup_vscode() {
  local output_dir="$1"
  local output_file
  local temp_dir
  local vscode_support="$HOME/Library/Application Support/Code"
  local vscode_extensions="$HOME/.vscode/extensions"

  assert_browser_closed vscode
  mkdir -p "$output_dir"
  output_file="$output_dir/$(archive_name vscode)"
  temp_dir="$(mktemp -d)"

  mkdir -p "$temp_dir/vscode"

  if [[ -d "$vscode_support/User" ]]; then
    mkdir -p "$temp_dir/vscode/Application Support/Code"
    rsync -a \
      --exclude='globalStorage' \
      --exclude='workspaceStorage' \
      --exclude='History' \
      --exclude='CachedData' \
      --exclude='Cache' \
      --exclude='CachedExtensionVSIXs' \
      "$vscode_support/User" \
      "$temp_dir/vscode/Application Support/Code/"
  fi

  if [[ -d "$vscode_extensions" ]]; then
    mkdir -p "$temp_dir/vscode/.vscode"
    rsync -a "$vscode_extensions" "$temp_dir/vscode/.vscode/"
  fi

  if command -v code >/dev/null 2>&1; then
    code --list-extensions > "$temp_dir/vscode/extensions.txt" || true
  fi

  tar -C "$temp_dir" -czf "$output_file" vscode
  rm -rf "$temp_dir"

  print "Created: $output_file"
}

restore_archive() {
  local archive="$1"
  local restore_root="$HOME/Library/Application Support"
  local temp_dir

  [[ -f "$archive" ]] || die "archive not found: $archive"
  mkdir -p "$restore_root"

  case "$(basename "$archive")" in
    *chrome*) assert_browser_closed chrome ;;
    *atlas*) assert_browser_closed atlas ;;
    *vscode*) assert_browser_closed vscode ;;
  esac

  if [[ "$(basename "$archive")" == *vscode* ]]; then
    temp_dir="$(mktemp -d)"
    tar -C "$temp_dir" -xzf "$archive"

    if [[ -d "$temp_dir/vscode/Application Support/Code/User" ]]; then
      mkdir -p "$HOME/Library/Application Support/Code"
      rsync -a "$temp_dir/vscode/Application Support/Code/User" "$HOME/Library/Application Support/Code/"
    fi

    if [[ -d "$temp_dir/vscode/.vscode/extensions" ]]; then
      mkdir -p "$HOME/.vscode"
      rsync -a "$temp_dir/vscode/.vscode/extensions" "$HOME/.vscode/"
    fi

    rm -rf "$temp_dir"
    print "Restored VS Code settings and extensions."
    print "Open VS Code and sign in again where required."
  else
    tar -C "$restore_root" -xzf "$archive"
    print "Restored into: $restore_root"
    print "Open the browser and sign in again where required."
  fi
}

main() {
  require_macos

  local command="${1:-}"
  local target="${2:-}"
  local output_dir="${3:-$HOME/Desktop}"

  case "$command" in
    backup)
      [[ -n "$target" ]] || { usage; exit 1; }
      case "$target" in
        chrome|atlas) backup_one "$target" "$output_dir" ;;
        vscode) backup_vscode "$output_dir" ;;
        all)
          backup_one chrome "$output_dir"
          backup_one atlas "$output_dir"
          backup_vscode "$output_dir"
          ;;
        *) die "backup target must be chrome, atlas, vscode, or all." ;;
      esac
      ;;
    restore)
      [[ -n "$target" ]] || { usage; exit 1; }
      restore_archive "$target"
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      die "unknown command '$command'."
      ;;
  esac
}

main "$@"
