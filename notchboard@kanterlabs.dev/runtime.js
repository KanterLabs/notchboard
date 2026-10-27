import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import {COLUMNS, MAX_CELLS, neighbor, nearestEmpty, capacity, isGridShortcut} from './grid.js';
import {GridDesktop} from './desktop.js';

export default class Notchboard extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._signals = [];
        this._sources = new Set();
        this._pending = new Set();
        this._windows = new Map();
        this._bindings = [];
        this._superActions = new Map();
        this._injections = new InjectionManager();
        this._stopping = false;
        this._overlayCompositing = false;
        this.ready = new Promise(resolve => { this._readyResolve = resolve; });
        try {
            this._configure();
            const wm = global.workspace_manager;
            this._oldLayout = [wm.layout_rows, wm.layout_columns];
            wm.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, -1, COLUMNS);
            this._setCount(Math.max(6, Math.ceil(wm.n_workspaces / COLUMNS) * COLUMNS));
            const extension = this;
            const animation = Main.wm._workspaceAnimation;
            this._injections.overrideMethod(animation, 'animateSwitch',
                original => (from, to, direction, done) => {
                    // Let a native touchpad gesture finish its own bookkeeping.
                    if (animation._switchData)
                        return original.call(animation, from, to, direction, done);
                    return this._animateSwitch(from, to, done);
                });
            this._injections.overrideMethod(Main.wm._workspaceAnimation, 'cancelSwitchAnimation',
                original => function (...args) {
                    // Mutter's kill handler completes this switch itself.
                    extension._finishSlide(false);
                    return original.apply(this, args);
                });
            for (const direction of ['left', 'right', 'up', 'down']) {
                for (const move of [false, true]) {
                    const name = `grid-${move ? 'move-' : ''}${direction}`;
                    const action = Main.wm.addKeybinding(name, this._settings,
                        Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
                        () => this._navigate(direction, move));
                    if (action === Meta.KeyBindingAction.NONE)
                        throw new Error(`Could not register ${name}`);
                    this._bindings.push(name);
                }
            }
            const reset = Main.wm.addKeybinding('grid-reset', this._settings,
                Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => this.resetGrid());
            if (reset === Meta.KeyBindingAction.NONE)
                throw new Error('Could not register grid-reset');
            this._bindings.push('grid-reset');
            const close = Main.wm.addKeybinding('grid-close-space', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL,
                () => this.closeCurrentSpace());
            if (close === Meta.KeyBindingAction.NONE)
                throw new Error('Could not register grid-close-space');
            this._bindings.push('grid-close-space');
            const notch = Main.wm.addKeybinding('grid-toggle-notch', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL,
                () => this._desktop?.toggleNotch());
            if (notch === Meta.KeyBindingAction.NONE)
                throw new Error('Could not register grid-toggle-notch');
            this._bindings.push('grid-toggle-notch');
            // Keep the native handler available for disable(), but use key-down
            // accelerators: Mutter's overlay-key signal arrives on release.
            this._overlayHandler = GObject.signal_handler_find(global.display, {signalId: 'overlay-key'});
            if (!this._overlayHandler)
                throw new Error('Could not locate the GNOME Super-key handler');
            GObject.signal_handler_block(global.display, this._overlayHandler);
            // Compositor accelerators run before Wayland forwards keys to
            // focused clients, including fullscreen apps. Stage capture does not.
            // Mutter applies changed overlay-key preferences asynchronously.
            this._later(0, () => {
                try {
                    for (const key of ['Super_L', 'Super_R']) {
                        const action = global.display.grab_accelerator(key,
                            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
                        if (action === Meta.KeyBindingAction.NONE)
                            throw new Error(`Could not register ${key}`);
                        const name = Meta.external_binding_name_for_action(action);
                        this._superActions.set(action, name);
                        Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
                    }
                    this._readyResolve?.(true);
                    this._readyResolve = null;
                } catch (error) {
                    this.disable();
                    Main.notifyError('Notchboard could not claim Super', error.message);
                    throw error;
                }
            }, GLib.PRIORITY_LOW);
            this._connect(global.display, 'accelerator-activated', (_display, action) => {
                if (!this._superActions.has(action) || this._superHeld)
                    return;
                this._superHeld = true;
                this._watchSuperRelease();
                this._superWasPinned = !!this._map && !!this._mapPinned;
                if (Main.actionMode === Shell.ActionMode.NORMAL)
                    this.toggleGrid();
                else if (Main.overview.visible) {
                    Main.overview.hide();
                    this._later(300, () => {
                        if (Main.actionMode === Shell.ActionMode.NORMAL)
                            this.toggleGrid();
                    });
                }
            });
            this._connect(Main.wm._shellwm, 'filter-keybinding', (_wm, binding) => {
                if ([...this._superActions.values()].includes(binding.get_name()))
                    return false;
                // Meta consumes registered chords before stage key events.
                // Observe them without filtering or replacing their actions.
                this._restoreSuperChord();
                return false;
            });
            this._desktop = new GridDesktop(this);
            this._syncOverlayCompositing();
            this._enableDiagnostics();
            this._connect(global.display, 'window-created', (_display, window) => this._queueWindow(window));
            this._connect(wm, 'active-workspace-changed', () => {
                if (this._map)
                    this._showMap();
                this._queueDesktopSync();
            });
            this._connect(wm, 'notify::n-workspaces', () => this._queueDesktopSync());
            // Any window mapping, raising or taking focus re-checks whether the
            // active cell is really empty, so the launcher never lingers over a window.
            this._connect(global.display, 'restacked', () => this._queueDesktopSync());
            this._connect(global.display, 'notify::focus-window', () => this._queueDesktopSync());
            this._connect(Main.overview, 'showing', () => this._hideMap(true));
            this._connect(Main.sessionMode, 'updated', () => {
                if (Main.sessionMode.isLocked)
                    this._hideMap(true);
            });
            this._connect(Main.layoutManager, 'monitors-changed', () => {
                this._hideMap(true);
                this._finishSlide();
            });
            this._connect(global.stage, 'captured-event', (_stage, event) => {
                const type = event.type();
                if (type === Clutter.EventType.KEY_PRESS && this._superHeld)
                    this._restoreSuperChord();
                if (this._map && event.type() === Clutter.EventType.KEY_PRESS &&
                    event.get_key_symbol() === Clutter.KEY_Escape)
                    this._hideMap(true);
                // A toggled map stays pinned while interacting with apps or
                // the notch. Only an explicit toggle or Escape dismisses it.
                return Clutter.EVENT_PROPAGATE;
            });
            const arrange = () => {
                const saved = this._reloadState;
                this._reloadState = null;
                const focused = saved?.focused ?? global.display.focus_window;
                if (saved) {
                    this._setCount(saved.count);
                    for (const [window, state] of saved.windows) {
                        if (window.get_compositor_private())
                            window.change_workspace(wm.get_workspace_by_index(state.cell));
                    }
                }
                const windows = global.get_window_actors().map(a => a.meta_window)
                    .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
                for (const window of windows)
                    this._place(window, false);
                if (saved) {
                    for (const [window, state] of saved.windows) {
                        if (this._windows.has(window)) {
                            this._windows.set(window, state.original);
                            if (!state.fullscreen && window.can_maximize())
                                window.maximize();
                        }
                    }
                    wm.get_workspace_by_index(saved.active)?.activate(global.get_current_time());
                    if (saved.pinned) {
                        this._mapPinned = true;
                        this._showMap();
                    }
                } else if (this._eligible(focused)) {
                    focused.get_workspace().activate_with_focus(focused, global.get_current_time());
                }
                this._queueDesktopSync();
            };
            if (Main.layoutManager._startingUp)
                this._connect(Main.layoutManager, 'startup-complete', arrange);
            else if (this._reloadState)
                arrange();
            else
                this._later(150, arrange);
            console.log('[Notchboard] enabled: Super + arrows; Shift carries a window');
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _queueDesktopSync() {
        this._cancel(this._desktopSyncId);
        this._desktopSyncId = this._later(0, () => this._desktop?.sync());
    }

    _later(ms, callback, priority = GLib.PRIORITY_DEFAULT) {
        const id = GLib.timeout_add(priority, ms, () => {
            this._sources.delete(id);
            if (!this._stopping) {
                try {
                    callback();
                } catch (error) {
                    console.error(`[Notchboard] ${error.stack ?? error}`);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _cancel(id) {
        if (id && this._sources.delete(id))
            GLib.source_remove(id);
    }

    _schemaSettings(id) {
        let source = Gio.SettingsSchemaSource.get_default();
        if (id === 'org.gnome.shell.extensions.tiling-assistant') {
            const dir = GLib.build_filenamev([GLib.get_user_data_dir(),
                'gnome-shell', 'extensions', 'tiling-assistant@leleat-on-github', 'schemas']);
            if (!GLib.file_test(`${dir}/gschemas.compiled`, GLib.FileTest.EXISTS))
                return null;
            source = Gio.SettingsSchemaSource.new_from_directory(dir, source, false);
        }
        const schema = source.lookup(id, true);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    }

    _restoreSettings() {
        const state = this._settings.get_string('restore-state');
        if (!state)
            return;
        for (const entry of JSON.parse(state)) {
            const settings = this._schemaSettings(entry.schema);
            if (!settings || !settings.settings_schema.has_key(entry.key))
                continue;
            // Preserve later user changes; only restore settings we still own.
            if (settings.get_value(entry.key).print(true) !== entry.applied)
                continue;
            if (entry.user === null)
                settings.reset(entry.key);
            else
                settings.set_value(entry.key, GLib.Variant.parse(null, entry.user, null, null));
        }
        this._settings.set_string('restore-state', '');
    }

    _configure() {
        // Recover our original settings even after an interrupted Shell process.
        this._restoreSettings();
        this._journal = [];
        const set = (settings, key, value) => {
            const old = settings.get_value(key);
            if (old.equal(value))
                return;
            this._journal.push({schema: settings.schema_id, key,
                user: settings.get_user_value(key)?.print(true) ?? null,
                applied: value.print(true)});
            this._settings.set_string('restore-state', JSON.stringify(this._journal));
            settings.set_value(key, value);
        };
        this._setOwned = set;
        this._prefs = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        set(new Gio.Settings({schema_id: 'org.gnome.mutter'}), 'dynamic-workspaces',
            new GLib.Variant('b', false));
        set(new Gio.Settings({schema_id: 'org.gnome.mutter'}), 'workspaces-only-on-primary',
            new GLib.Variant('b', false));
        // Release Mutter's standalone overlay binding for our press/release
        // accelerators. Super+arrow and other chord bindings still work.
        set(new Gio.Settings({schema_id: 'org.gnome.mutter'}), 'overlay-key',
            new GLib.Variant('s', ''));
        for (const id of ['org.gnome.desktop.wm.keybindings', 'org.gnome.mutter.keybindings',
            'org.gnome.shell.keybindings', 'org.gnome.shell.extensions.tiling-assistant']) {
            const settings = this._schemaSettings(id);
            if (!settings)
                continue;
            for (const key of settings.settings_schema.list_keys()) {
                const value = settings.get_value(key);
                if (value.get_type_string() !== 'as')
                    continue;
                const keys = value.deep_unpack();
                const filtered = keys.filter(k => !isGridShortcut(k));
                if (filtered.length !== keys.length)
                    set(settings, key, new GLib.Variant('as', filtered));
            }
        }
    }

    _setCount(count) {
        count = Math.min(MAX_CELLS, count);
        // Keep a single original value while updating the owned value on growth.
        const entry = this._journal.find(e => e.schema === this._prefs.schema_id && e.key === 'num-workspaces');
        if (entry) {
            entry.applied = new GLib.Variant('i', count).print(true);
            this._settings.set_string('restore-state', JSON.stringify(this._journal));
            this._prefs.set_int('num-workspaces', count);
        } else {
            this._setOwned(this._prefs, 'num-workspaces', new GLib.Variant('i', count));
        }
        // Mutter updates settings asynchronously; allocate synchronously for new windows.
        while (global.workspace_manager.n_workspaces < count)
            global.workspace_manager.append_new_workspace(false, global.get_current_time());
    }

    _eligible(window) {
        return window && window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.get_transient_for() && !window.is_override_redirect() &&
            !window.is_skip_taskbar() && !window.is_on_all_workspaces();
    }

    _occupied(except = null) {
        const occupied = new Set();
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (window !== except && this._eligible(window) && window.get_workspace())
                occupied.add(window.get_workspace().index());
        }
        return occupied;
    }

    _queueWindow(window) {
        this._pending.add(window);
        const actor = window.get_compositor_private();
        if (actor) {
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                this._signals = this._signals.filter(([object, signal]) => object !== actor || signal !== id);
                // first-frame is emitted during paint. Switching workspaces
                // here would violate Mutter's frame accounting; defer it.
                this._later(0, () => {
                    if (this._pending.delete(window) && window.get_compositor_private())
                        this._place(window, true);
                    this._queueDesktopSync();
                });
            });
            this._signals.push([actor, id]);
            const destroyId = actor.connect('destroy', () => {
                this._pending.delete(window);
                this._signals = this._signals.filter(([object]) => object !== actor);
                this._queueDesktopSync();
            });
            this._signals.push([actor, destroyId]);
        }
        // Bounded fallback for clients whose first frame already arrived.
        this._later(200, () => {
            if (this._pending.delete(window) && window.get_compositor_private())
                this._place(window, true);
            this._queueDesktopSync();
        });
    }

    _place(window, follow) {
        if (!this._eligible(window) || this._windows.has(window))
            return;
        const wm = global.workspace_manager;
        const workspace = window.get_workspace();
        if (!workspace)
            return;
        const origin = workspace.index();
        const occupied = this._occupied(window);
        let target = nearestEmpty(origin, occupied, wm.n_workspaces);
        if (target < 0 && wm.n_workspaces < MAX_CELLS) {
            this._setCount(wm.n_workspaces + COLUMNS);
            target = nearestEmpty(origin, occupied, wm.n_workspaces);
        }
        if (target < 0) {
            Main.notify('Notchboard is full', 'All 36 cells are occupied. Close a window to free a cell.');
            return;
        }
        this._windows.set(window, {workspace, maximized: window.get_maximize_flags(),
            rect: window.get_frame_rect()});
        const id = window.connect('unmanaged', () => {
            window.disconnect(id);
            this._signals = this._signals.filter(([object, signal]) => object !== window || signal !== id);
            this._windows.delete(window);
            this._pending.delete(window);
            this._later(0, () => {
                if (this._map) this._showMap();
                this._desktop?.sync();
            });
        });
        this._signals.push([window, id]);
        const workspaceId = window.connect('workspace-changed', () => this._queueDesktopSync());
        this._signals.push([window, workspaceId]);
        const unmanagedId = window.connect('unmanaged', () => {
            window.disconnect(workspaceId);
            window.disconnect(unmanagedId);
            this._signals = this._signals.filter(([object]) => object !== window);
        });
        this._signals.push([window, unmanagedId]);
        window.change_workspace(wm.get_workspace_by_index(target));
        if (window.can_maximize() && !window.is_fullscreen())
            window.maximize();
        const highest = Math.max(target, ...this._occupied());
        this._setCount(capacity(highest, wm.n_workspaces));
        if (follow) {
            window.get_workspace().activate_with_focus(window, global.get_current_time());
            this._showMap();
        }
        this._queueDesktopSync();
    }

    _navigate(direction, move = false) {
        this._restoreSuperChord();
        const wm = global.workspace_manager;
        const current = wm.get_active_workspace_index();
        const target = neighbor(current, direction, wm.n_workspaces);
        this._showMap();
        if (target === current) {
            this._nudge(direction);
            return;
        }
        const destination = wm.get_workspace_by_index(target);
        if (move) {
            let window = global.display.focus_window;
            while (window?.get_transient_for())
                window = window.get_transient_for();
            if (!this._eligible(window) || window.get_workspace()?.index() !== current)
                window = wm.get_active_workspace().list_windows().find(w => this._eligible(w));
            if (!this._eligible(window) || this._occupied(window).has(target)) {
                this._nudge(direction);
                return;
            }
            window.change_workspace(destination);
            window.get_workspace().activate_with_focus(window, global.get_current_time());
            this._setCount(capacity(Math.max(...this._occupied()), wm.n_workspaces));
        } else {
            const window = destination.list_windows().find(w => this._eligible(w));
            if (window)
                destination.activate_with_focus(window, global.get_current_time());
            else
                destination.activate(global.get_current_time());
        }
        this._showMap();
    }

    _duration() {
        return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_boolean('enable-animations') ? this._settings.get_int('animation-ms') : 0;
    }

    _finishSlide(complete = true) {
        if (!this._slide)
            return;
        const slide = this._slide;
        this._slide = null;
        this._cancel(slide.timeout);
        for (const actor of slide.actors)
            actor.destroy();
        global.compositor.enable_unredirect();
        global.stage.queue_redraw();
        if (complete)
            slide.done();
    }

    _animateSwitch(from, to, done) {
        // Settle an interrupted transition immediately; never queue key presses.
        this._finishSlide();
        const duration = this._duration();
        if (!duration || this._resetting || Main.overview.visible) {
            done();
            return;
        }
        const wm = global.workspace_manager;
        const dx = Math.sign(to % COLUMNS - from % COLUMNS);
        const dy = Math.sign(Math.floor(to / COLUMNS) - Math.floor(from / COLUMNS));
        const slide = this._slide = {actors: [], done};
        global.compositor.disable_unredirect();
        try {
            for (const monitor of Main.layoutManager.monitors) {
                const container = new Clutter.Actor({x: monitor.x, y: monitor.y,
                    width: monitor.width, height: monitor.height, clip_to_allocation: true});
                slide.actors.push(container);
                Main.uiGroup.insert_child_above(container, this._desktop?.launcher ?? global.window_group);
                const old = new WorkspaceGroup(wm.get_workspace_by_index(from), monitor, null);
                const next = new WorkspaceGroup(wm.get_workspace_by_index(to), monitor, null);
                container.add_child(old);
                container.add_child(next);
                const x = dx * (monitor.width + 20);
                const y = dy * (monitor.height + 20);
                next.set_position(x, y);
                old.ease({translation_x: -x, translation_y: -y, duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                next.ease({x: 0, y: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            }
            slide.timeout = this._later(duration + 20, () => this._finishSlide());
        } catch (error) {
            this._finishSlide();
            console.error(`[Notchboard] slide: ${error.stack ?? error}`);
        }
    }

    _enableDiagnostics() {
        this._diagnostics = Gio.DBusExportedObject.wrapJSObject(`<node>
          <interface name="dev.kanterlabs.Notchboard.Diagnostics">
            <method name="Inspect"><arg type="s" direction="out"/></method>
          </interface></node>`, {Inspect: () => JSON.stringify(this._inspectToggle())});
        this._diagnostics.export(Gio.DBus.session, '/dev/kanterlabs/Notchboard/Diagnostics');
    }

    _inspectToggle() {
        const focus = global.display.focus_window;
        return {
            mode: Main.actionMode, normalMode: Shell.ActionMode.NORMAL,
            held: !!this._superHeld, modifiers: global.get_pointer()[2],
            compositing: !!this._overlayCompositing,
            map: !!this._map, pinned: !!this._mapPinned, mapVisible: this._map?.is_mapped() ?? false,
            actor: this._map ? {
                opacity: this._map.opacity, paintOpacity: this._map.get_paint_opacity(),
                position: this._map.get_transformed_position(), size: this._map.get_transformed_size(),
                parentOpacity: this._map.get_parent()?.opacity,
                transition: !!this._map.get_transition('opacity'),
                clip: this._map.get_parent()?.clip_to_allocation,
                stack: Main.uiGroup.get_children().indexOf(this._map),
                topWindowsStack: Main.uiGroup.get_children().indexOf(global.top_window_group),
            } : null,
            notch: this._desktop?.notch.is_mapped() ?? false,
            power: this._desktop?.power ? {
                mapped: this._desktop.power.notch.is_mapped(),
                position: this._desktop.power.notch.get_transformed_position(),
                battery: this._desktop.power.notch.contains(this._desktop.battery.track),
                airpods: this._desktop.power.notch.contains(this._desktop.airpods.button),
            } : null,
            fullscreen: focus?.is_fullscreen() ?? false,
            app: focus ? Shell.WindowTracker.get_default().get_window_app(focus)?.get_id() : null,
            overview: Main.overview.visible, locked: Main.sessionMode.isLocked,
            actions: [...this._superActions],
            resolvedLeft: global.display.get_keybinding_action(133, 0),
            resolvedRight: global.display.get_keybinding_action(134, 0),
            active: global.workspace_manager.get_active_workspace_index(),
            launcher: this._desktop?.launcher?.visible ?? false,
            airpods: this._desktop?.airpods ? {connected: this._desktop.airpods.connected,
                shown: this._desktop.airpods.button.visible, label: this._desktop.airpods._label.text,
                broadcast: this._desktop.airpods._broadcast} : null,
            switching: {shell: !!Main.wm._switchInProgress, slide: !!this._slide,
                native: !!Main.wm._workspaceAnimation._switchData},
            occupied: [...this._occupied()],
            windows: global.get_window_actors().map(({meta_window: w}) => ({
                app: Shell.WindowTracker.get_default().get_window_app(w)?.get_id() ?? null,
                workspace: w.get_workspace()?.index() ?? null, type: w.get_window_type(),
                eligible: this._eligible(w), placed: this._windows.has(w), all: w.is_on_all_workspaces(),
                skip: w.is_skip_taskbar(), minimized: w.minimized, transient: !!w.get_transient_for(),
                shown: w.get_compositor_private()?.visible ?? false,
            })),
        };
    }

    _syncOverlayCompositing() {
        const visible = !this._stopping && !Main.sessionMode.isLocked &&
            !!(this._map || this._desktop?.notch.visible || this._desktop?.power?.notch.visible ||
            this._desktop?.launcher?.visible);
        if (visible === this._overlayCompositing)
            return;
        this._overlayCompositing = visible;
        // Fullscreen/direct scanout may bypass Shell overlays even though
        // their input actors remain mapped. Balance our own inhibition only.
        if (visible)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
        global.stage.queue_redraw();
    }

    _watchSuperRelease() {
        // Modifier releases can also go straight to Wayland clients. Watch
        // compositor modifier state only while Super is down; no idle polling.
        this._later(16, () => {
            if (!(global.get_pointer()[2] & Clutter.ModifierType.MOD4_MASK))
                this._superHeld = false;
            if (this._superHeld)
                this._watchSuperRelease();
        });
    }

    _restoreSuperChord() {
        if (!this._superHeld)
            return;
        // A chord is not a standalone toggle. Retain the pin state from
        // before Super was pressed; navigation will show its normal preview.
        const wasPinned = this._superWasPinned;
        if (!wasPinned && this._mapPinned)
            this._hideMap(true);
        this._mapPinned = wasPinned;
        if (wasPinned && !this._map)
            this._showMap();
    }

    toggleGrid() {
        if (this._map && this._mapPinned) {
            this._hideMap();
        } else {
            this._mapPinned = true;
            this._showMap();
        }
    }

    _hideMap(immediate = false) {
        this._mapPinned = false;
        this._cancel(this._mapTimer);
        this._mapTimer = 0;
        if (!this._map)
            return;
        const actor = this._map;
        this._map = null;
        this._selection = null;
        // Track fading actors so disable also removes them.
        this._fading ??= new Set();
        const destroy = () => { this._fading.delete(actor); actor.destroy(); };
        if (immediate) {
            destroy();
        } else {
            this._fading.add(actor);
            actor.ease({opacity: 0, translation_y: 8, duration: this._duration() ? 100 : 0,
                onComplete: destroy});
        }
    }

    _showMap() {
        if (this._stopping || Main.sessionMode.isLocked || Main.overview.visible || !Main.layoutManager.primaryMonitor)
            return;
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        const monitor = Main.layoutManager.primaryMonitor;
        const totalRows = Math.ceil(wm.n_workspaces / COLUMNS);
        const rows = Math.min(3, totalRows);
        const firstRow = Math.min(Math.max(0, Math.floor(active / COLUMNS) - 1), totalRows - rows);
        const signature = `${firstRow}:${rows}:${wm.n_workspaces}:${[...this._windows.keys()].map(w => `${w.get_stable_sequence()}@${w.get_workspace()?.index()}`).join(',')}`;
        if (this._map && this._mapSignature !== signature) {
            const pinned = this._mapPinned;
            this._hideMap(true);
            this._mapPinned = pinned;
        }
        const tileW = Math.floor(Math.min(164, (monitor.width - 100) / COLUMNS));
        const tileH = Math.round(tileW * 0.66);
        const gap = 10;
        const inset = 18;
        if (!this._map) {
            this._mapSignature = signature;
            const width = inset * 2 + tileW * COLUMNS + gap * (COLUMNS - 1);
            const height = inset * 2 + 32 + rows * tileH + gap * (rows - 1) + 28;
            this._map = new St.Widget({style_class: 'notchboard-map', reactive: false,
                width, height, opacity: 255, translation_y: 8});
            const map = this._map;
            this._syncOverlayCompositing();
            // Keep navigation above fullscreen windows and application popups.
            // Session-mode changes still explicitly hide it when locked.
            Main.layoutManager.addTopChrome(map, {affectsInputRegion: true, trackFullscreen: false});
            map.set_position(Math.round(monitor.x + (monitor.width - width) / 2),
                Math.round(monitor.y + monitor.height - height - 64));
            const heading = new St.Label({style_class: 'notchboard-heading',
                text: `NOTCHBOARD   ·   ${wm.n_workspaces} spaces`});
            map.add_child(heading);
            heading.set_position(inset, inset);
            for (let i = firstRow * COLUMNS; i < (firstRow + rows) * COLUMNS; i++) {
                const workspace = wm.get_workspace_by_index(i);
                const window = workspace.list_windows().find(w => this._eligible(w));
                const tile = new St.Button({style_class: 'notchboard-cell',
                    accessible_name: `Row ${Math.floor(i / COLUMNS) + 1}, column ${i % COLUMNS + 1}: ${window?.get_title() ?? 'Empty'}`,
                    width: tileW, height: tileH});
                tile.set_position(inset + (i % COLUMNS) * (tileW + gap),
                    inset + 32 + (Math.floor(i / COLUMNS) - firstRow) * (tileH + gap));
                map.add_child(tile);
                const contents = new St.Widget({width: tileW, height: tileH, clip_to_allocation: true});
                tile.set_child(contents);
                if (window) {
                    const actor = window.get_compositor_private();
                    if (actor && actor.width > 0 && actor.height > 0) {
                        const clone = new Clutter.Clone({source: actor});
                        const scale = Math.min((tileW - 10) / actor.width, (tileH - 32) / actor.height);
                        clone.set_scale(scale, scale);
                        clone.set_position((tileW - actor.width * scale) / 2, 5);
                        contents.add_child(clone);
                    }
                    const app = Shell.WindowTracker.get_default().get_window_app(window);
                    if (app) {
                        const icon = app.create_icon_texture(16);
                        contents.add_child(icon);
                        icon.set_position(8, tileH - 25);
                    }
                }
                const label = new St.Label({style_class: window ? 'notchboard-title' : 'notchboard-empty',
                    text: window?.get_title() ?? 'Empty', width: tileW - 38});
                contents.add_child(label);
                label.set_position(window ? 30 : 10, tileH - 25);
                tile.connect('clicked', () => {
                    workspace.activate(global.get_current_time());
                    if (this._mapPinned)
                        this._showMap();
                    else
                        this._hideMap(true);
                });
            }
            this._selection = new St.Widget({style_class: 'notchboard-selection',
                reactive: false, width: tileW, height: tileH});
            map.add_child(this._selection);
            const hint = new St.Label({style_class: 'notchboard-hint',
                text: `Super + ↑ ↓ ← →   ·   Shift carries   ·   Rows ${firstRow + 1}–${firstRow + rows}`});
            map.add_child(hint);
            hint.set_position(inset, height - inset - 15);
            map.ease({translation_y: 0, duration: this._duration() ? 90 : 0});
            map.queue_redraw();
        }
        const x = inset + active % COLUMNS * (tileW + gap);
        const y = inset + 32 + (Math.floor(active / COLUMNS) - firstRow) * (tileH + gap);
        if (!this._selection.positioned) {
            this._selection.set_position(x, y);
            this._selection.positioned = true;
        } else {
            this._selection.ease({x, y, duration: this._duration(),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        this._cancel(this._mapTimer);
        this._mapShownAt = GLib.get_monotonic_time();
        this._checkMapHeld();
    }

    _checkMapHeld() {
        this._mapTimer = this._later(80, () => {
            const [, , modifiers] = global.get_pointer();
            const age = (GLib.get_monotonic_time() - this._mapShownAt) / 1000;
            if (this._map && (this._mapPinned || (modifiers & Clutter.ModifierType.MOD4_MASK) || age < 250))
                this._checkMapHeld();
            else
                this._hideMap();
        });
    }

    _nudge(direction) {
        if (!this._map || !this._duration())
            return;
        const horizontal = direction === 'left' || direction === 'right';
        const distance = direction === 'left' || direction === 'up' ? -7 : 7;
        const actor = this._map;
        actor.ease({translation_x: horizontal ? distance : 0,
            translation_y: horizontal ? 0 : distance, duration: 65,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => actor.ease({translation_x: 0, translation_y: 0,
                duration: 100, mode: Clutter.AnimationMode.EASE_OUT_CUBIC})});
    }

    closeCurrentSpace() {
        const workspace = global.workspace_manager.get_active_workspace();
        // Close windows, never quit their application: another window from the
        // same app may belong to a different cell. Native close requests retain
        // save/cancel prompts; the launcher appears only once the cell is empty.
        const windows = workspace.list_windows().filter(window =>
            this._eligible(window) && window.get_workspace() === workspace);
        this._hideMap(true);
        for (const window of windows) {
            if (window.can_close())
                window.delete(global.get_current_time());
        }
        this._queueDesktopSync();
        if (!windows.length) {
            this._desktop?.sync();
            this._desktop?.search?.set_text('');
            this._desktop?.search?.grab_key_focus();
        }
    }

    resetGrid() {
        // Repack, never close applications. Move before removing empty workspaces.
        this._hideMap(true);
        this._finishSlide();
        const wm = global.workspace_manager;
        const windows = global.get_window_actors().map(actor => actor.meta_window)
            .filter(window => this._eligible(window))
            .sort((a, b) => a.get_workspace().index() - b.get_workspace().index() ||
                a.get_stable_sequence() - b.get_stable_sequence()).slice(0, MAX_CELLS);
        this._resetting = true;
        try {
            for (const [index, window] of windows.entries())
                window.change_workspace(wm.get_workspace_by_index(index));
            const first = wm.get_workspace_by_index(0);
            if (windows.length)
                first.activate_with_focus(windows[0], global.get_current_time());
            else
                first.activate(global.get_current_time());
            const count = capacity(windows.length - 1);
            this._setCount(count);
            while (wm.n_workspaces > count)
                wm.remove_workspace(wm.get_workspace_by_index(wm.n_workspaces - 1), global.get_current_time());
        } finally {
            this._resetting = false;
        }
        this._desktop?.sync();
        Main.notify('Grid reset', `${windows.length} windows packed together. Your apps are still open.`);
    }

    captureReloadState() {
        return {
            count: global.workspace_manager.n_workspaces,
            active: global.workspace_manager.get_active_workspace_index(),
            focused: global.display.focus_window,
            pinned: !!this._mapPinned,
            windows: new Map([...this._windows].map(([window, original]) => [window, {
                cell: window.get_workspace().index(), original, fullscreen: window.is_fullscreen(),
            }])),
        };
    }

    disable() {
        this._stopping = true;
        this._syncOverlayCompositing();
        this._diagnostics?.unexport();
        this._diagnostics = null;
        this._readyResolve?.(false);
        this._readyResolve = null;
        this._superHeld = false;
        this._desktop?.destroy();
        this._desktop = null;
        for (const name of this._bindings ?? [])
            Main.wm.removeKeybinding(name);
        this._bindings = [];
        for (const [action, name] of this._superActions ?? []) {
            Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
            global.display.ungrab_accelerator(action);
        }
        this._superActions?.clear();
        for (const [object, id] of this._signals ?? []) {
            try {
                // Shell's JS signal emitters are not GObjects.
                if (!(object instanceof GObject.Object) || GObject.signal_handler_is_connected(object, id))
                    object.disconnect(id);
            } catch (_) { /* finalized window */ }
        }
        this._signals = [];
        if (this._overlayHandler && GObject.signal_handler_is_connected(global.display, this._overlayHandler))
            GObject.signal_handler_unblock(global.display, this._overlayHandler);
        this._overlayHandler = 0;
        this._pending?.clear();
        this._finishSlide();
        this._hideMap(true);
        for (const actor of this._fading ?? [])
            actor.destroy();
        this._fading?.clear();
        for (const id of this._sources ?? [])
            GLib.source_remove(id);
        this._sources?.clear();
        this._injections?.clear();
        // Return existing windows to their original workspace and geometry.
        for (const [window, state] of this._windows ?? []) {
            try {
                if (state.workspace.index() >= 0)
                    window.change_workspace(state.workspace);
                if (!state.maximized) {
                    window.unmaximize();
                    const r = state.rect;
                    window.move_resize_frame(false, r.x, r.y, r.width, r.height);
                } else {
                    window.unmaximize();
                    window.maximize();
                    if (state.maximized !== Meta.MaximizeFlags.BOTH)
                        window.set_unmaximize_flags(Meta.MaximizeFlags.BOTH ^ state.maximized);
                }
            } catch (_) { /* window already closed */ }
        }
        this._windows?.clear();
        if (this._oldLayout)
            global.workspace_manager.override_workspace_layout(Meta.DisplayCorner.TOPLEFT,
                false, ...this._oldLayout);
        if (this._settings)
            this._restoreSettings();
        this._settings = null;
        console.log('[Notchboard] disabled; original workspace settings and shortcuts restored');
    }
}

