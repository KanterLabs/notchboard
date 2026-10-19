#!/usr/bin/env bash
# Install or update Notchboard for the current user. Updates go live in the
# running session; the very first install needs one logout so GNOME Shell
# discovers the extension.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
uuid=notchboard@kanterlabs.dev
src="$repo_dir/$uuid"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}

# Keep a copy of every setting Notchboard may change, plus the previous release.
backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/notchboard/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
for path in /org/gnome/desktop/wm/ /org/gnome/mutter/ /org/gnome/shell/extensions/tiling-assistant/ \
        /org/gnome/shell/extensions/notchboard/; do
    name=${path%/}
    dconf dump "$path" > "$backup_dir/${name##*/}.dconf"
done
gsettings get org.gnome.shell enabled-extensions > "$backup_dir/enabled.gvariant"
gsettings get org.gnome.shell disabled-extensions > "$backup_dir/disabled.gvariant"
if [[ -d $dest ]]; then
    cp -a -- "$dest" "$backup_dir/extension"
fi

python3 "$repo_dir/scripts/stage.py" "$src" "$dest"
python3 - "$uuid" <<'PY'
import sys
from gi.repository import Gio
uuid = sys.argv[1]
s = Gio.Settings.new('org.gnome.shell')
enabled = s.get_strv('enabled-extensions')
if uuid not in enabled:
    s.set_strv('enabled-extensions', enabled + [uuid])
disabled = s.get_strv('disabled-extensions')
if uuid in disabled:
    s.set_strv('disabled-extensions', [x for x in disabled if x != uuid])
Gio.Settings.sync()
PY
echo "Notchboard staged. Backup: $backup_dir"

if python3 "$repo_dir/scripts/reload.py" --status > "$backup_dir/status-before.json" 2>/dev/null; then
    if ! python3 "$repo_dir/scripts/reload.py"; then
        # Keep the working release selected on disk after a rejected update.
        python3 - "$dest/current.json" "$backup_dir/status-before.json" <<'PY'
import json, os, sys
path, old = sys.argv[1:]
status = json.load(open(old))
if status['revision']:
    temporary = path + '.rollback'
    with open(temporary, 'w') as f:
        json.dump({k: status[k] for k in ('revision', 'version')}, f)
    os.replace(temporary, path)
PY
        exit 1
    fi
    python3 "$repo_dir/scripts/reload.py" --status
else
    echo 'Log out and back in once so GNOME Shell discovers Notchboard. Later updates reload live.'
fi
