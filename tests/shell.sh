#!/usr/bin/env bash
# Real compositor integration test. Separate D-Bus, settings, data and runtime.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d /tmp/notchboard-shell.XXXXXX)
chmod 700 "$test_dir"
mkdir -p "$test_dir/data/gnome-shell/extensions" "$test_dir/config" "$test_dir/runtime"
chmod 700 "$test_dir/runtime"
if [[ ${NOTCHBOARD_TEST_TILING:-0} == 1 ]]; then
    cp -a "$HOME/.local/share/gnome-shell/extensions/tiling-assistant@leleat-on-github" "$test_dir/data/gnome-shell/extensions/"
fi
if [[ ${NOTCHBOARD_TEST_DOCK:-0} == 1 ]]; then
    cp -a "$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com" "$test_dir/data/gnome-shell/extensions/"
fi
mkdir -p "$test_dir/data/applications"
cat > "$test_dir/data/applications/dev.kanterlabs.NotchboardLaunch.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Grid Launch Verification
Exec=gjs -m $repo_dir/tests/launcher-client.js
Icon=applications-development
StartupWMClass=dev.kanterlabs.NotchboardLaunch
EOF
python3 "$repo_dir/scripts/stage.py" "$repo_dir/notchboard@kanterlabs.dev" "$test_dir/data/gnome-shell/extensions/notchboard@kanterlabs.dev" > "$test_dir/staged.json"
cp -a "$repo_dir/tests/shell-extension" "$test_dir/data/gnome-shell/extensions/notchboard-test@kanterlabs.dev"
glib-compile-schemas --strict "$test_dir/data/gnome-shell/extensions/notchboard@kanterlabs.dev/schemas"
glib-compile-schemas --strict "$test_dir/data/gnome-shell/extensions/notchboard-test@kanterlabs.dev/schemas"
export NOTCHBOARD_TEST_REPO="$repo_dir"
export NOTCHBOARD_TEST_DIR="$test_dir"
export NOTCHBOARD_TEST_CLIENT="$repo_dir/tests/client.js"
export XDG_DATA_HOME="$test_dir/data" XDG_CONFIG_HOME="$test_dir/config" XDG_RUNTIME_DIR="$test_dir/runtime"
export XDG_CACHE_HOME="$test_dir/cache" GSETTINGS_BACKEND=keyfile GTK_A11Y=none GSK_RENDERER=cairo
unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS
echo "Isolated test artifacts: $test_dir"
dbus-run-session -- bash -c '
    set -euo pipefail
    python3 -c '\''from gi.repository import Gio; s=Gio.Settings.new("org.gnome.shell"); s.set_strv("enabled-extensions", ["notchboard-test@kanterlabs.dev", "notchboard@kanterlabs.dev"]); Gio.Settings.sync()'\''
    if [[ ${NOTCHBOARD_TEST_TILING:-0} == 1 ]]; then
        python3 -c '\''from gi.repository import Gio; s=Gio.Settings.new("org.gnome.shell"); s.set_strv("enabled-extensions", ["tiling-assistant@leleat-on-github"]+s.get_strv("enabled-extensions")); Gio.Settings.sync()'\''
    fi
    if [[ ${NOTCHBOARD_TEST_DOCK:-0} == 1 ]]; then
        python3 -c '\''from gi.repository import Gio; s=Gio.Settings.new("org.gnome.shell"); s.set_strv("enabled-extensions", ["dash-to-dock@micxgx.gmail.com"]+s.get_strv("enabled-extensions")); Gio.Settings.sync()'\''
        GSETTINGS_SCHEMA_DIR="$XDG_DATA_HOME/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas" gsettings set org.gnome.shell.extensions.dash-to-dock dock-fixed true
    fi
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "49.9"
    # Keep idle/lock transitions out of this bounded UI interaction test.
    gsettings set org.gnome.desktop.session idle-delay 0
    gsettings set org.gnome.desktop.screensaver lock-enabled false
    gsettings set org.gnome.mutter dynamic-workspaces true
    python3 -c '\''import json,os; from gi.repository import Gio; s=Gio.Settings.new("org.gnome.desktop.wm.keybindings"); json.dump({k:s.get_user_value(k).print_(True) if s.get_user_value(k) is not None else None for k in s.props.settings_schema.list_keys()},open(os.environ["NOTCHBOARD_TEST_DIR"]+"/bindings-before.json","w"))'\''
    export WAYLAND_DISPLAY=grid-test-0
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display grid-test-0 > "$NOTCHBOARD_TEST_DIR/shell.log" 2>&1 &
    shell_pid=$!
    trap '\''kill "$shell_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true'\'' EXIT
    for ((attempt=0; attempt<90; attempt++)); do
        if [[ -s "$NOTCHBOARD_TEST_DIR/result.json" ]]; then
            cat "$NOTCHBOARD_TEST_DIR/result.json"
            python3 -c '\''import json,os; r=json.load(open(os.environ["NOTCHBOARD_TEST_DIR"]+"/result.json")); raise SystemExit(0 if r["passed"] else 1)'\''
            exit $?
        fi
        if ! kill -0 "$shell_pid" 2>/dev/null; then break; fi
        sleep 1
    done
    tail -70 "$NOTCHBOARD_TEST_DIR/shell.log"
    exit 1
'
