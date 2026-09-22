#!/usr/bin/env bash
# Homesick uninstaller — removes everything install.sh added and restores changed settings.
set -euo pipefail

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_DIR="$DATA/gnome-shell/extensions"
STATE="$DATA/homesick"
BIN="$HOME/.local/bin"
APP_ID="app.homesick.DiskUtility"
UUIDS=(dock@homesick spotlight@homesick resize@homesick)

info() { printf '  %s\n' "$*"; }

printf '\033[1m%s\033[0m\n' "Removing Homesick"

current="$(gsettings get org.gnome.shell enabled-extensions)"
for uuid in "${UUIDS[@]}"; do
    gnome-extensions disable "$uuid" 2>/dev/null || true
    current="$(sed -E "s/'$uuid'(, )?//; s/, \]/]/" <<<"$current")"
    if [[ -d "$EXT_DIR/$uuid" ]]; then
        rm -rf "${EXT_DIR:?}/$uuid"
        info "✓ removed $uuid"
    fi
done
gsettings set org.gnome.shell enabled-extensions "$current"

rm -f "$BIN/disk-utility" "$DATA/applications/$APP_ID.desktop" "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
rm -rf "$STATE/disk-utility"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications" 2>/dev/null || true
info "✓ removed Disk Utility"

if [[ -f "$STATE/settings-backup" ]]; then
    while read -r schema key value; do
        gsettings set "$schema" "$key" "$value"
        info "✓ restored $schema $key"
    done <"$STATE/settings-backup"
fi
rm -rf "$STATE/settings-backup"
rmdir "$STATE" 2>/dev/null || true
# Spotlight keeps a small launch-history file to rank results.
rm -rf "$DATA/homesick-spotlight"

echo
info "Done. Log out and back in to fully unload the extensions."
