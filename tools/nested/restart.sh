#!/usr/bin/env bash
# Restarts the test session (tools/nested/run.sh) and its text app, picking up
# a freshly installed NextKeyBor. Usage: tools/nested/restart.sh [DIR]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-/tmp/nkb-nested}
for p in $(pgrep -x gnome-shell); do
    if tr '\0' ' ' < "/proc/$p/cmdline" | grep -q -- '--wayland-display nkb-test'; then kill "$p"; fi
done
sleep 2
setsid "$here/run.sh" "$dir" > "$dir.log" 2>&1 < /dev/null &
for _ in $(seq 40); do
    [[ -s $dir/bus ]] && grep -q "GNOME Shell started" "$dir.log" 2>/dev/null && break
    sleep 0.5
done
DBUS_SESSION_BUS_ADDRESS=$(cat "$dir/bus") WAYLAND_DISPLAY=nkb-test GDK_BACKEND=wayland GTK_A11Y=none \
    setsid "$here/textapp.py" "$dir/text.txt" > "$dir.textapp.log" 2>&1 < /dev/null &
sleep 3
echo "test session ready: $dir"
