#!/usr/bin/env python3
"""Stage an immutable runtime, then atomically select it for live activation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

FILES = ('runtime.js', 'desktop.js', 'bell.js', 'airpods.js', 'battery.js', 'grid.js', 'stylesheet.css', 'metadata.json',
         'schemas/org.gnome.shell.extensions.notchboard.gschema.xml',
         'icons/notchboard-bell-symbolic.svg', 'icons/notchboard-bell-muted-symbolic.svg')


def stage(source: Path, destination: Path):
    digest = hashlib.sha256()
    for name in FILES:
        digest.update(name.encode() + b'\0' + (source / name).read_bytes() + b'\0')
    revision = digest.hexdigest()
    releases = destination / 'releases'
    releases.mkdir(parents=True, exist_ok=True)
    release = releases / revision
    if not release.exists():
        temporary = Path(tempfile.mkdtemp(prefix='.stage-', dir=releases))
        try:
            for name in FILES:
                target = temporary / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / name, target)
            subprocess.run(['glib-compile-schemas', '--strict', str(temporary / 'schemas')], check=True)
            temporary.rename(release)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    # Keep the entry point and source mirrors available for GNOME discovery,
    # profile validation, and the one-time migration from pre-loader versions.
    for name in ('extension.js', *FILES):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    subprocess.run(['glib-compile-schemas', '--strict', str(destination / 'schemas')], check=True)
    manifest = {'revision': revision, 'version': json.loads((source / 'metadata.json').read_text())['version']}
    with tempfile.NamedTemporaryFile(mode='w', dir=destination, prefix='.current-', delete=False) as stream:
        json.dump(manifest, stream)
        stream.write('\n')
        temporary_manifest = stream.name
    os.replace(temporary_manifest, destination / 'current.json')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(stage(args.source, args.destination)))
