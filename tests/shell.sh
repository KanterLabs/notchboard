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
# NOTCHBOARD_TEST_SCALE=2 renders the same 1280x800 layout at 2x on a light
# background, so the black islands stand out in README screenshots.
scale=${NOTCHBOARD_TEST_SCALE:-1}
if [[ $scale != 1 ]]; then
    cat > "$test_dir/config/monitors.xml" <<EOF
<monitors version="2"><configuration><layoutmode>logical</layoutmode>
  <logicalmonitor><x>0</x><y>0</y><scale>$scale</scale><primary>yes</primary>
    <monitor><monitorspec><connector>Meta-0</connector><vendor>MetaVendor</vendor><product>MetaVirtualMonitor</product><serial>0x00</serial></monitorspec>
      <mode><width>$((1280 * scale))</width><height>$((800 * scale))</height><rate>60.000</rate></mode></monitor>
  </logicalmonitor></configuration></monitors>
EOF
fi
export NOTCHBOARD_TEST_SCALE="$scale"
export NOTCHBOARD_TEST_MONITOR="$((1280 * scale))x$((800 * scale))"
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
    if [[ $NOTCHBOARD_TEST_SCALE != 1 ]]; then
        for key in picture-uri picture-uri-dark; do gsettings set org.gnome.desktop.background $key ""; done
        gsettings set org.gnome.desktop.background picture-options none
        gsettings set org.gnome.desktop.background color-shading-type vertical
        gsettings set org.gnome.desktop.background primary-color "#f3f5f9"
        gsettings set org.gnome.desktop.background secondary-color "#cdd6e4"
    fi
    python3 -c '\''import json,os; from gi.repository import Gio; s=Gio.Settings.new("org.gnome.desktop.wm.keybindings"); json.dump({k:s.get_user_value(k).print_(True) if s.get_user_value(k) is not None else None for k in s.props.settings_schema.list_keys()},open(os.environ["NOTCHBOARD_TEST_DIR"]+"/bindings-before.json","w"))'\''
    export WAYLAND_DISPLAY=grid-test-0
    gnome-shell --headless --wayland --no-x11 --virtual-monitor "$NOTCHBOARD_TEST_MONITOR" --wayland-display grid-test-0 > "$NOTCHBOARD_TEST_DIR/shell.log" 2>&1 &
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
