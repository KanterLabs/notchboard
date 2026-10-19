import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Keep this entry point small and stable. GNOME caches it for the session;
// every runtime revision and all its relative imports have a unique directory.
const IFACE = `<node><interface name="dev.kanterlabs.Notchboard">
  <method name="GetStatus"><arg type="s" direction="out"/></method>
  <method name="Reload"><arg type="s" direction="out"/></method>
</interface></node>`;
export const DBUS_PATH = '/dev/kanterlabs/Notchboard';

// A predecessor extension in the same session (Window Grid, before it was
// renamed) can hand over its live layout here instead of a logout.
export const ADOPT = Symbol.for('notchboard-adopt');

function capture(runtime) {
    return runtime.captureReloadState();
}

function adopt() {
    const state = globalThis[ADOPT] ?? null;
    delete globalThis[ADOPT];
    return state;
}

export default class NotchboardLoader extends Extension {
    async enable() {
        const token = this._token = {};
        try {
            // Let an interrupted import finish cancelling before a new enable.
            await this._updating?.catch(() => {});
            if (this._token !== token)
                return;
            await this.reload();
            if (this._token !== token)
                return;
            this._exportDbus();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _exportDbus() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);
    }

    disable() {
        this._token = null;
        this._dbus?.unexport();
        this._dbus = null;
        this._runtime?.disable();
        this._runtime = null;
        this._revision = null;
        // ExtensionManager unloads the active release's stylesheet next.
    }

    GetStatus() {
        return JSON.stringify({
            active: !!this._runtime && !this._runtime._stopping,
            revision: this._revision?.revision ?? null,
            version: this._revision?.version ?? null,
            updating: !!this._updating,
            error: this._lastError ?? null,
        });
    }

    ReloadAsync(_params, invocation) {
        this.reload().then(() => invocation.return_value(
            new GLib.Variant('(s)', [this.GetStatus()]))).catch(error =>
            invocation.return_dbus_error('dev.kanterlabs.Notchboard.UpdateFailed', error.message));
    }

    reload() {
        if (!this._token)
            return Promise.reject(new Error('Notchboard is disabled'));
        if (this._updating)
            return Promise.reject(new Error('A Notchboard update is already running'));
        this._updating = this._reload().finally(() => { this._updating = null; });
        return this._updating;
    }

    _readRevision() {
        const [, bytes] = this.dir.get_child('current.json').load_contents(null);
        const revision = JSON.parse(new TextDecoder().decode(bytes));
        if (!/^[a-f0-9]{64}$/.test(revision.revision) || !Number.isInteger(revision.version))
            throw new Error('Invalid Notchboard release manifest');
        return revision;
    }

    _useStylesheet(file) {
        const record = Main.extensionManager.lookup(this.uuid);
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const previous = record.stylesheet;
        theme.load_stylesheet(file);
        if (previous && !previous.equal(file))
            theme.unload_stylesheet(previous);
        record.stylesheet = file;
    }

    async _reload() {
        const token = this._token;
        const revision = this._readRevision();
        if (this._revision?.revision === revision.revision && this._runtime)
            return;
        const release = this.dir.get_child('releases').get_child(revision.revision);
        // Import before dismantling the working UI. Syntax/import errors leave
        // its windows, settings and handlers untouched. Dependencies are fresh too.
        let Runtime;
        try {
            ({default: Runtime} = await import(release.get_child('runtime.js').get_uri()));
            if (typeof Runtime !== 'function')
                throw new Error('Release has no Notchboard runtime');
        } catch (error) {
            this._lastError = error.message;
            throw error;
        }
        if (this._token !== token)
            throw new Error('Notchboard was disabled during import');
        const previous = this._runtime;
        const previousRevision = this._revision;
        const previousStylesheet = Main.extensionManager.lookup(this.uuid).stylesheet;
        const snapshot = previous ? capture(previous) : adopt();
        const next = new Runtime({...this.metadata, dir: release, path: release.get_path()});
        try {
            previous?.disable();
            this._runtime = next;
            this._useStylesheet(release.get_child('stylesheet.css'));
            next._reloadState = snapshot;
            next.enable();
            if (!await next.ready || this._token !== token)
                throw new Error('Notchboard did not finish activating');
            this._revision = revision;
            this._lastError = null;
            Main.extensionManager.lookup(this.uuid).metadata.version = revision.version;
            console.log(`[Notchboard] running v${revision.version} release ${revision.revision}`);
        } catch (error) {
            next.disable();
            this._runtime = null;
            this._revision = previousRevision;
            this._lastError = error.message;
            if (previous && this._token === token) {
                this._useStylesheet(previousStylesheet);
                previous._reloadState = snapshot;
                previous.enable();
                if (previous.ready && !await previous.ready)
                    throw new Error(`Update failed and rollback could not activate: ${error.message}`);
                this._runtime = previous;
            }
            throw error;
        }
    }
}
