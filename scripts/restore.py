#!/usr/bin/env python3
"""Emergency recovery if Notchboard cannot load to run its normal disable path."""
import json
import os
from pathlib import Path

os.environ.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', f"unix:path={os.environ['XDG_RUNTIME_DIR']}/bus")
from gi.repository import Gio, GLib

uuid = 'notchboard@kanterlabs.dev'
root = Path(GLib.get_user_data_dir()) / 'gnome-shell/extensions'
default_source = Gio.SettingsSchemaSource.get_default()
source = Gio.SettingsSchemaSource.new_from_directory(str(root / uuid / 'schemas'), default_source, False)
settings = Gio.Settings.new_full(source.lookup('org.gnome.shell.extensions.notchboard', False), None, None)
shell = Gio.Settings.new('org.gnome.shell')
shell.set_strv('enabled-extensions', [x for x in shell.get_strv('enabled-extensions') if x != uuid])
disabled = shell.get_strv('disabled-extensions')
if uuid not in disabled:
    shell.set_strv('disabled-extensions', disabled + [uuid])
Gio.Settings.sync()
for entry in json.loads(settings.get_string('restore-state') or '[]'):
    entry_source = default_source
    if entry['schema'] == 'org.gnome.shell.extensions.tiling-assistant':
        schema_dir = root / 'tiling-assistant@leleat-on-github/schemas'
        if not schema_dir.exists():
            continue
        entry_source = Gio.SettingsSchemaSource.new_from_directory(str(schema_dir), default_source, False)
    schema = entry_source.lookup(entry['schema'], True)
    if schema is None or not schema.has_key(entry['key']):
        continue
    target = Gio.Settings.new_full(schema, None, None)
    if target.get_value(entry['key']).print_(True) != entry['applied']:
        continue
    if entry['user'] is None:
        target.reset(entry['key'])
    else:
        target.set_value(entry['key'], GLib.Variant.parse(None, entry['user'], None, None))
settings.set_string('restore-state', '')
Gio.Settings.sync()
print('Notchboard disabled and its owned settings restored. Log out and back in if its UI was still active.')
