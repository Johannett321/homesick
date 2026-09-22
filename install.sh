#!/usr/bin/env bash
# Homesick installer — installs everything for the current user only (no sudo).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_DIR="$DATA/gnome-shell/extensions"
STATE="$DATA/homesick"
BIN="$HOME/.local/bin"
APP_ID="app.homesick.DiskUtility"

ALL=(dock spotlight emoji resize disk-utility)
declare -A UUID=([dock]="dock@homesick" [spotlight]="spotlight@homesick" [emoji]="emoji@homesick" [resize]="resize@homesick")
declare -A TITLE=([dock]="Dock" [spotlight]="Spotlight (Option+Space launcher)" [emoji]="Emoji picker (Ctrl+Space)" [resize]="Option Resize" [disk-utility]="Disk Utility")

ASSUME_YES=0
BUTTONS=""          # "left", "keep" or "" (ask)
SELECTED=("${ALL[@]}")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: ./install.sh [options]

Installs Homesick for the current user. Nothing needs root.

Options:
  --only LIST            install only these components (comma separated)
  --skip LIST            install everything except these components
  --window-buttons-left  put close/minimize/maximize on the left, like macOS
  --keep-window-buttons  don't touch the window button layout
  -y, --yes              don't ask questions; use the defaults
  -h, --help             show this help

Components: ${ALL[*]}
EOF
}

parse_list() { tr ',' ' ' <<<"$1"; }
valid() { local c; for c in "${ALL[@]}"; do [[ $c == "$1" ]] && return 0; done; return 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --only) shift; SELECTED=(); for c in $(parse_list "${1:-}"); do valid "$c" || die "unknown component '$c'"; SELECTED+=("$c"); done ;;
        --skip) shift; skip=" $(parse_list "${1:-}") "; SELECTED=(); for c in "${ALL[@]}"; do [[ $skip == *" $c "* ]] || SELECTED+=("$c"); done ;;
        --window-buttons-left) BUTTONS=left ;;
        --keep-window-buttons) BUTTONS=keep ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage; die "unknown option '$1'" ;;
    esac
    shift
done

has() { local c; for c in "${SELECTED[@]}"; do [[ $c == "$1" ]] && return 0; done; return 1; }

ask() { # ask "question" default(y/n)
    local default="$2" reply
    if [[ $ASSUME_YES == 1 || ! -t 0 ]]; then [[ $default == y ]]; return; fi
    read -r -p "  $1 [$([[ $default == y ]] && echo Y/n || echo y/N)] " reply
    reply="${reply:-$default}"
    [[ ${reply,,} == y* ]]
}

# Remember a setting's original value once, so uninstall.sh can restore it.
backup_setting() {
    local schema="$1" key="$2" file="$STATE/settings-backup"
    mkdir -p "$STATE"
    touch "$file"
    grep -q "^$schema $key " "$file" || printf '%s %s %s\n' "$schema" "$key" "$(gsettings get "$schema" "$key")" >>"$file"
}

enable_extension() {
    local uuid="$1" current
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    [[ $current == *"'$uuid'"* ]] && return 0
    if [[ $current == "@as []" || $current == "[]" ]]; then
        current="['$uuid']"
    else
        current="${current%]}, '$uuid']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$current"
}

# ---- checks -------------------------------------------------------------------

bold "Homesick — macOS comforts for GNOME"
[[ $EUID -eq 0 ]] && die "run this as your normal user, not root"
command -v gnome-shell >/dev/null || die "GNOME Shell isn't installed"
command -v gsettings >/dev/null || die "gsettings is missing"

shell_version="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
info "GNOME Shell $shell_version detected"
if (( shell_version < 46 )); then
    die "GNOME Shell 46 or newer is required"
elif (( shell_version != 50 )); then
    warn "Homesick is tested on GNOME 50; version $shell_version should work but isn't tested"
fi
[[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* ]] || warn "you don't seem to be in a GNOME session right now"

if has disk-utility; then
    if ! gjs -c "imports.gi.versions.Gtk='4.0'; imports.gi.versions.Adw='1'; imports.gi.Adw;" 2>/dev/null; then
        warn "Disk Utility needs gjs, GTK 4 and libadwaita — skipping it"
        SELECTED=("${SELECTED[@]/disk-utility}")
    fi
fi

echo
bold "Installing: $(for c in "${SELECTED[@]}"; do [[ -n $c ]] && printf '%s, ' "${TITLE[$c]}"; done | sed 's/, $//')"

# ---- extensions ---------------------------------------------------------------

needs_relogin=0
mkdir -p "$EXT_DIR"
for c in dock spotlight emoji resize; do
    has "$c" || continue
    uuid="${UUID[$c]}"
    rm -rf "${EXT_DIR:?}/$uuid"
    cp -r "$REPO/extensions/$uuid" "$EXT_DIR/$uuid"
    enable_extension "$uuid"
    info "✓ ${TITLE[$c]} → $EXT_DIR/$uuid"
    needs_relogin=1
done

# Spotlight's shortcut is Alt+Space, which GNOME uses for the window menu by default.
if has spotlight; then
    current="$(gsettings get org.gnome.desktop.wm.keybindings activate-window-menu)"
    if [[ $current == *"<Alt>space"* ]]; then
        echo
        info "Spotlight opens with Option+Space (Alt+Space). GNOME uses that shortcut for the"
        info "window menu, which you can still open by right-clicking a title bar."
        if ask "Free up Alt+Space for Spotlight?" y; then
            backup_setting org.gnome.desktop.wm.keybindings activate-window-menu
            gsettings set org.gnome.desktop.wm.keybindings activate-window-menu "[]"
            info "✓ Alt+Space is now free"
        else
            warn "Alt+Space is still taken — Spotlight won't open until you free it"
        fi
    fi
fi

# ---- Disk Utility -------------------------------------------------------------

if has disk-utility; then
    dest="$STATE/disk-utility"
    rm -rf "$dest"
    mkdir -p "$dest" "$BIN" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps"
    cp -r "$REPO/apps/disk-utility/." "$dest/"
    cp "$REPO/apps/disk-utility/icons/$APP_ID.svg" "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
    cat >"$BIN/disk-utility" <<EOF
#!/bin/sh
exec gjs -m "$dest/main.js" "\$@"
EOF
    chmod +x "$BIN/disk-utility"
    cat >"$DATA/applications/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Disk Utility
GenericName=Disk Utility
Comment=View drives, partitions and volumes, and check their health
Exec=$BIN/disk-utility
Icon=$APP_ID
Terminal=false
Categories=GTK;System;
Keywords=disk;drive;partition;volume;mount;usb;ssd;health;smart;
StartupNotify=true
StartupWMClass=$APP_ID
EOF
    command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications" 2>/dev/null || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f "$DATA/icons/hicolor" 2>/dev/null || true
    info "✓ Disk Utility → $dest (launch it from the app grid or run 'disk-utility')"
    command -v gnome-disks >/dev/null || warn "GNOME Disks isn't installed; Erase/Partition/Restore need it"
fi

# ---- window buttons -------------------------------------------------------------

layout="$(gsettings get org.gnome.desktop.wm.preferences button-layout)"
if [[ $BUTTONS != keep && $layout != "'close,minimize,maximize:appmenu'" ]]; then
    echo
    if [[ $BUTTONS == left ]] || { [[ -z $BUTTONS ]] && ask "Move window buttons (close, minimize, maximize) to the left like macOS?" n; }; then
        backup_setting org.gnome.desktop.wm.preferences button-layout
        gsettings set org.gnome.desktop.wm.preferences button-layout 'close,minimize,maximize:appmenu'
        info "✓ Window buttons moved to the left"
    fi
fi

# ---- done -------------------------------------------------------------------

echo
bold "Done!"
if [[ $needs_relogin == 1 ]]; then
    info "Log out and back in to load the extensions (GNOME only picks up new or"
    info "updated extensions at login on Wayland)."
fi
info "To remove everything again, run ./uninstall.sh"
