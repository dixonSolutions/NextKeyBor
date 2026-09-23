#!/usr/bin/env bash
# Runs a nested GNOME Shell (in a window you can also use) with NextKeyBor on its own D-Bus session and a
# copy of your settings, so the extension can be tested without logging out.
# Usage: tools/nested/run.sh [DIR]   (DIR holds state; default /tmp/nkb-nested)
# Drive it with tools/nested/drive.py using the same DIR.
set -euo pipefail
dir=${1:-/tmp/nkb-nested}
rm -rf "$dir" && mkdir -p "$dir/config/dconf"

# Settings: a copy, so nothing the test session changes reaches your desktop.
cp ~/.config/dconf/user "$dir/config/dconf/user"

cat > "$dir/session.sh" <<INNER
#!/usr/bin/env bash
echo "\$DBUS_SESSION_BUS_ADDRESS" > "$dir/bus"
gsettings set org.gnome.desktop.a11y.applications screen-keyboard-enabled true
exec gnome-shell --devkit --wayland --no-x11 --virtual-monitor 1440x960 \
    --wayland-display nkb-test
INNER
chmod +x "$dir/session.sh"

export XDG_CONFIG_HOME="$dir/config"
unset WAYLAND_DISPLAY DISPLAY
exec dbus-run-session -- "$dir/session.sh"
