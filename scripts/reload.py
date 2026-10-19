#!/usr/bin/env python3
"""Ask the running Notchboard loader to activate and verify its staged release."""
import json
import sys

from gi.repository import Gio, GLib


def call(method):
    return Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
        'org.gnome.Shell', '/dev/kanterlabs/Notchboard', 'dev.kanterlabs.Notchboard',
        method, None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 20000, None,
    ).unpack()[0]


if __name__ == '__main__':
    try:
        if '--status' in sys.argv:
            print(call('GetStatus'))
        else:
            result = json.loads(call('Reload'))
            if not result['active']:
                raise RuntimeError('The release did not become active')
            print(json.dumps(result))
    except (GLib.Error, RuntimeError) as error:
        print(f'Notchboard: {error}', file=sys.stderr)
        sys.exit(1)
