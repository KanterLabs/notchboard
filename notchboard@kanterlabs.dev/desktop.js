import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {COLUMNS, nearestEmpty} from './grid.js';
import {NotificationBell} from './bell.js';
import {AirPodsIndicator} from './airpods.js';
import {BatteryLine} from './battery.js';

const DOCK = 'dash-to-dock@micxgx.gmail.com';
export const ISLAND_GAP = 6;
const EDGE = 2;

// Desktop chrome is independent of workspace placement and owns every actor,
// signal and temporarily hidden dock that it creates or changes.
export class GridDesktop {
    constructor(owner) {
        this.owner = owner;
        this._signals = [];
        this._docks = new Map();
        this.expanded = false;
        this.revealed = true;
        this._peek = false;
        this._pulseUntil = 0;
        this._lastActive = null;
        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._buildNotch();
        this._connect(owner._settings, 'changed::hosted-indicator', () => {
            this._restoreAi();
            this._syncAi();
        });
        this._connect(owner._settings, 'changed::notch-hidden', () => {
            this._peek = false;
            this._syncReveal();
        });
        this._syncReveal(true);
        this._takePanel();
        this._connect(this._appSystem, 'installed-changed', () => this._reloadApps());
        this._connect(this._favorites, 'changed', () => this._reloadApps());
        this._connect(Main.overview, 'showing', () => this.sync());
        this._connect(Main.overview, 'hidden', () => this.sync());
        this._connect(Main.sessionMode, 'updated', () => this.sync());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._destroyLauncher();
            this.sync();
            this._hideDocks();
        });
        this._connect(Main.extensionManager, 'extension-state-changed', (_m, extension) => {
            if (extension.uuid === DOCK && extension.state === 1)
                this._hideDocks();
            if (extension.uuid === this._hostedKey())
                this._syncAi();
        });
        this._connect(Main.layoutManager, 'startup-complete', () => {
            this.sync();
            this._hideDocks();
        });
        this._reloadApps();
        this._hideDocks();
        this.sync();
    }

    _connect(object, signal, callback) {
        const pair = [object, object.connect(signal, callback)];
        this._signals.push(pair);
        return pair;
    }

    _button(label, accessible, action) {
        const button = new St.Button({label, style_class: 'notchboard-action',
            accessible_name: accessible, can_focus: true});
        button.connect('clicked', action);
        return button;
    }

    _buildNotch() {
        // Dynamic Island: a floating black pill whose top row never moves, with
        // a drawer of extra controls that opens beneath it on hover.
        this.notch = new St.BoxLayout({style_class: 'notchboard-notch', vertical: true,
            reactive: true, track_hover: true});
        const compact = new St.BoxLayout({style_class: 'notchboard-notch-compact',
            x_align: Clutter.ActorAlign.CENTER});
        this._gridButton = new St.Button({style_class: 'notchboard-notch-main', can_focus: true,
            accessible_name: 'Show workspace grid'});
        this._mini = new St.Widget({width: 34, height: 25});
        this._gridButton.set_child(this._mini);
        this._gridButton.connect('clicked', () => this.owner.toggleGrid());
        compact.add_child(this._gridButton);
        this._clockLabel = new St.Label({style_class: 'notchboard-clock',
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Current time'});
        compact.add_child(this._clockLabel);
        this._aiSlot = new St.BoxLayout({style_class: 'notchboard-ai', y_align: Clutter.ActorAlign.CENTER});
        this._aiPlaceholder = new St.Label({text: 'AI usage', style_class: 'notchboard-ai-placeholder',
            y_align: Clutter.ActorAlign.CENTER});
        this._aiSlot.add_child(this._aiPlaceholder);
        compact.add_child(this._aiSlot);
        this.airpods = new AirPodsIndicator(this);
        compact.add_child(this.airpods.button);
        this.bell = new NotificationBell(this);
        compact.add_child(this.bell.button);
        this.notch.add_child(compact);
        this._drawer = new St.BoxLayout({style_class: 'notchboard-notch-drawer',
            x_align: Clutter.ActorAlign.CENTER, clip_to_allocation: true, visible: false});
        this._position = new St.Label({style_class: 'notchboard-notch-label', y_align: Clutter.ActorAlign.CENTER});
        this._drawer.add_child(this._position);
        this.battery = new BatteryLine(this);
        this._drawer.add_child(this.battery.label);
        this._drawer.add_child(this._button('+', 'Go to an empty workspace', () => this.goEmpty()));
        this._drawer.add_child(this._button('↻', 'Reset grid layout without closing windows', () => this.owner.resetGrid()));
        const hide = new St.Button({style_class: 'notchboard-action', can_focus: true,
            accessible_name: 'Hide the island (Super+Shift+H)',
            child: new St.Icon({icon_name: 'view-conceal-symbolic', icon_size: 14})});
        hide.connect('clicked', () => this.toggleNotch());
        this._drawer.add_child(hide);
        this.notch.add_child(this._drawer);
        this.notch.add_child(this.battery.track);
        this._wallClock = new GnomeDesktop.WallClock();
        this._clockSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._connect(this._wallClock, 'notify::clock', () => this._updateClock());
        this._connect(this._clockSettings, 'changed::clock-format', () => this._updateClock());
        this._connect(this.notch, 'notify::width', () => this._positionNotch());
        this._connect(this.notch, 'notify::hover', () => {
            this._queueIsland(this.notch.hover ? 0 : 280);
            if (!this.notch.hover)
                this._queueConceal();
        });
        // The replacement panel must remain above fullscreen windows and popups.
        Main.layoutManager.addTopChrome(this.notch, {affectsInputRegion: true, trackFullscreen: false});
        // While the island is hidden, a thin strip along the top edge brings it
        // back for as long as the pointer stays on the strip or the island.
        this._edge = new St.Widget({reactive: true, track_hover: true, visible: false, height: EDGE});
        this._connect(this._edge, 'notify::hover', () => {
            if (this._edge.hover && this._hidden()) {
                this._peek = true;
                this._syncReveal();
            } else {
                this._queueConceal();
            }
        });
        Main.layoutManager.addTopChrome(this._edge, {affectsInputRegion: true, trackFullscreen: false});
        this._updateClock();
    }

    _queueIsland(delay) {
        if (this._islandId)
            GLib.source_remove(this._islandId);
        this._islandId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._islandId = 0;
            this._syncIsland();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidden() {
        return this.owner._settings.get_boolean('notch-hidden');
    }

    _menuOpen() {
        return !!(this._ai?.indicator.menu?.isOpen || this.bell?.menu.isOpen || this.airpods?.menu.isOpen);
    }

    // Shown at all times unless the user hides it; the setting persists.
    toggleNotch() {
        const hide = !this._hidden();
        if (hide) {
            this.bell.menu.close();
            this.airpods.menu.close();
            this._ai?.indicator.menu?.close();
        }
        this.owner._settings.set_boolean('notch-hidden', hide);
    }

    _queueConceal() {
        if (this._concealId)
            GLib.source_remove(this._concealId);
        this._concealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._concealId = 0;
            if (this._peek && !this._edge.hover && !this.notch.hover && !this._menuOpen()) {
                this._peek = false;
                this._syncReveal();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Slides the island up out of view when hidden; once off screen it is
    // unmapped, so it takes no input and fullscreen apps may bypass the Shell.
    _syncReveal(instant = false) {
        if (this._destroyed)
            return;
        const locked = Main.sessionMode.isLocked;
        this._edge.visible = !locked && this._hidden();
        const show = !locked && (!this._hidden() || this._peek);
        if (show === this.revealed)
            return;
        this.revealed = show;
        const notch = this.notch;
        const offset = -(notch.height + ISLAND_GAP + 24);
        const duration = instant || locked || !this.owner._duration() ? 0 : 240;
        notch.remove_transition('translation-y');
        if (show) {
            if (!notch.visible)
                notch.translation_y = offset;
            notch.show();
            this.owner._syncOverlayCompositing();
            notch.ease({translation_y: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            notch.ease({translation_y: offset, duration, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    if (this.revealed || this._destroyed)
                        return;
                    notch.hide();
                    notch.translation_y = 0;
                    this.owner._syncOverlayCompositing();
                }});
        }
        this._syncIsland();
    }

    // Open while hovered or briefly after a workspace switch; an open AI or
    // notification menu keeps the drawer shut so it never covers the menu.
    _syncIsland() {
        if (this._destroyed)
            return;
        if (this._peek)
            this._queueConceal();
        const open = this.revealed && (this.notch.hover || GLib.get_monotonic_time() < this._pulseUntil) &&
            !this._menuOpen() && !Main.sessionMode.isLocked;
        if (open === this.expanded)
            return;
        this.expanded = open;
        const drawer = this._drawer;
        const duration = this.owner._duration() ? 220 : 0;
        const from = drawer.visible ? drawer.height : 0;
        drawer.remove_all_transitions();
        if (open) {
            drawer.height = -1;
            drawer.show();
            const [, target] = drawer.get_preferred_height(-1);
            drawer.set({height: from, opacity: from ? drawer.opacity : 0});
            drawer.ease({height: target, opacity: 255, duration,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
                onComplete: () => { drawer.height = -1; }});
        } else {
            drawer.height = from;
            drawer.ease({height: 0, opacity: 0, duration: duration * 0.8,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => { drawer.hide(); drawer.height = -1; }});
        }
    }

    _pulseIsland() {
        this._pulseUntil = GLib.get_monotonic_time() + 1600 * 1000;
        this._syncIsland();
        this._queueIsland(1650);
    }

    // A brief red glow around the island marks a notification arrival.
    alertIsland() {
        if (this._alertId)
            GLib.source_remove(this._alertId);
        this.notch.add_style_class_name('alert');
        this._alertId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            this._alertId = 0;
            this.notch.remove_style_class_name('alert');
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        const twelve = this._clockSettings.get_string('clock-format') === '12h';
        this._clockLabel.text = now.format(twelve ? '%-l:%M %p' : '%H:%M');
        this._positionNotch();
    }

    _positionNotch() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._destroyed || !this.notch.get_stage())
            return;
        const [, width] = this.notch.get_preferred_width(-1);
        this.notch.set_position(Math.round(monitor.x + (monitor.width - width) / 2), monitor.y + ISLAND_GAP);
        this._edge.width = width + 40;
        this._edge.set_position(Math.round(monitor.x + (monitor.width - this._edge.width) / 2), monitor.y);
    }

    _takePanel() {
        const actor = Main.layoutManager.panelBox;
        this._panelState = {visible: actor.visible, struts: new Map()};
        this._connect(actor, 'notify::visible', () => this._hidePanel());
        this._connect(actor, 'notify::allocation', () => this._hidePanel());
        this._hidePanel();
    }

    _hidePanel() {
        if (this._destroyed || Main.sessionMode.isLocked)
            return;
        const actor = Main.layoutManager.panelBox;
        const data = Main.layoutManager._trackedActors.find(entry => entry.actor === actor);
        if (data?.affectsStruts) {
            if (!this._panelState.struts.has(data))
                this._panelState.struts.set(data, data.affectsStruts);
            data.affectsStruts = false;
            Main.layoutManager._queueUpdateRegions();
        }
        if (actor.visible)
            actor.hide();
    }

    _syncAi() {
        if (this._destroyed)
            return;
        const key = this._hostedKey();
        const indicator = key ? Main.panel.statusArea[key] : null;
        this._syncPlaceholder();
        if (indicator === this._ai?.indicator)
            return;
        this._restoreAi();
        const container = indicator?.container;
        const parent = container?.get_parent();
        if (!container || !parent)
            return;
        const index = parent.get_children().indexOf(container);
        this._ai = {indicator, container, parent, index};
        this._aiPlaceholder.hide();
        parent.remove_child(container);
        this._aiSlot.add_child(container);
        const destroyId = container.connect('destroy', () => {
            this._ai = null;
            if (!this._destroyed) {
                this._syncPlaceholder();
                this._positionNotch();
            }
        });
        this._ai.destroyId = destroyId;
        this._ai.menuId = indicator.menu?.connect('open-state-changed', () => this._syncIsland());
        this._syncIsland();
        this._positionNotch();
    }

    // Hold the indicator's place only while its extension is still loading.
    _syncPlaceholder() {
        const key = this._hostedKey();
        this._aiPlaceholder.visible = !this._ai && !!key && !!Main.extensionManager.lookup(key);
    }

    // The panel indicator shown in the island, by its status-area key.
    _hostedKey() {
        return this.owner._settings.get_string('hosted-indicator');
    }

    _restoreAi() {
        if (!this._ai)
            return;
        const {indicator, container, parent, index, destroyId, menuId} = this._ai;
        this._ai = null;
        if (menuId)
            indicator.menu.disconnect(menuId);
        indicator.menu?.close();
        container.disconnect(destroyId);
        container.get_parent()?.remove_child(container);
        parent.insert_child_at_index(container, Math.min(index, parent.get_children().length));
        this._syncPlaceholder();
    }

    async _hideDocks() {
        try {
            const extension = Main.extensionManager.lookup(DOCK);
            if (extension?.state === 1) {
                const module = await import(extension.dir.get_child('extension.js').get_uri());
                if (this._destroyed)
                    return;
                const manager = module.dockManager;
                if (manager && manager !== this._dockManager) {
                    this._dockManager = manager;
                    this._connect(manager, 'docks-ready', () => this._hideDocks());
                }
                for (const actor of manager?._allDocks ?? [])
                    this._hideDockActor(actor);
            }
            if (!this._destroyed && Main.overview.dash)
                this._hideDockActor(Main.overview.dash);
        } catch (error) {
            console.error(`[Notchboard] dock: ${error.stack ?? error}`);
        }
    }

    _hideDockActor(actor) {
        if (this._docks.has(actor))
            return;
        const visible = actor.visible;
        const visibleId = actor.connect('notify::visible', () => {
            this._suppressDockStruts(actor);
            if (!this._destroyed && actor.visible)
                actor.hide();
        });
        const allocationId = actor.connect('notify::allocation', () => this._suppressDockStruts(actor));
        const destroyId = actor.connect('destroy', () => this._docks.delete(actor));
        this._docks.set(actor, {visible, visibleId, allocationId, destroyId, struts: new Map()});
        this._suppressDockStruts(actor);
        actor.hide();
        Main.layoutManager._queueUpdateRegions();
    }

    _suppressDockStruts(actor) {
        const state = this._docks.get(actor);
        if (!state || this._destroyed)
            return;
        const data = Main.layoutManager._trackedActors.find(entry => entry.actor === actor);
        // GNOME keeps struts even for hidden actors. Release that reserved
        // area without changing any of the user's persistent dock settings.
        if (data?.affectsStruts) {
            if (!state.struts.has(data))
                state.struts.set(data, data.affectsStruts);
            data.affectsStruts = false;
            Main.layoutManager._queueUpdateRegions();
        }
    }

    _reloadApps() {
        this.apps = this._appSystem.get_installed().filter(info => info.should_show())
            .map(info => this._appSystem.lookup_app(info.get_id())).filter(Boolean);
        const favoriteIds = this._favorites.getFavorites().map(app => app.get_id());
        const usageIds = Shell.AppUsage.get_default().get_most_used().map(app => app.get_id());
        const priority = [...new Set([...favoriteIds, ...usageIds])];
        this.apps.sort((a, b) => {
            const rank = app => { const i = priority.indexOf(app.get_id()); return i < 0 ? 10000 : i; };
            return rank(a) - rank(b) || a.get_name().localeCompare(b.get_name());
        });
        if (this.launcher)
            this._renderApps();
    }

    _buildLauncher(monitor) {
        const width = Math.min(760, monitor.width - 64);
        this._columns = width >= 700 ? 6 : 4;
        this._rows = monitor.height >= 720 ? 3 : 2;
        this._tileWidth = Math.floor((width - 64 - (this._columns - 1) * 10) / this._columns);
        this.launcher = new St.BoxLayout({vertical: true, style_class: 'notchboard-launcher',
            width, reactive: true, visible: false});
        const header = new St.BoxLayout({style_class: 'notchboard-launcher-header'});
        const titles = new St.BoxLayout({vertical: true, x_expand: true});
        this._launcherTitle = new St.Label({text: 'Make space for something good.', style_class: 'notchboard-launcher-title'});
        this._launcherSubtitle = new St.Label({style_class: 'notchboard-launcher-subtitle'});
        titles.add_child(this._launcherTitle);
        titles.add_child(this._launcherSubtitle);
        header.add_child(titles);
        header.add_child(this._button('Reset grid', 'Pack windows and remove unused rows', () => this.owner.resetGrid()));
        this.launcher.add_child(header);
        this.search = new St.Entry({hint_text: 'Search your apps…', can_focus: true,
            style_class: 'notchboard-search', x_expand: true});
        this.search.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 18}));
        this.search.clutter_text.connect('text-changed', () => this._renderApps());
        this.search.clutter_text.connect('activate', () => {
            if (this.results?.length)
                this.launch(this.results[this._selected ?? 0]);
        });
        this.search.clutter_text.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (event.get_state() & (Clutter.ModifierType.MOD4_MASK |
                Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK))
                return Clutter.EVENT_PROPAGATE;
            if (this.search.get_text() && [Clutter.KEY_Left, Clutter.KEY_Right].includes(key))
                return Clutter.EVENT_PROPAGATE;
            const delta = {[Clutter.KEY_Down]: this._columns, [Clutter.KEY_Up]: -this._columns,
                [Clutter.KEY_Right]: 1, [Clutter.KEY_Left]: -1}[key];
            if (delta !== undefined && this.results?.length) {
                this._selected = Math.max(0, Math.min(this.results.length - 1, (this._selected ?? 0) + delta));
                this._highlightApp();
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Escape) {
                if (this.search.get_text())
                    this.search.set_text('');
                else
                    global.stage.set_key_focus(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.launcher.add_child(this.search);
        this._appGrid = new St.Widget({height: this._rows * 100 + (this._rows - 1) * 10,
            x_expand: true});
        this.launcher.add_child(this._appGrid);
        this._launcherFooter = new St.Label({style_class: 'notchboard-launcher-subtitle'});
        this.launcher.add_child(this._launcherFooter);
        Main.layoutManager.addChrome(this.launcher, {affectsInputRegion: true, trackFullscreen: true});
        // GNOME's window_group also paints wallpaper: the empty-workspace
        // launcher must sit above it. sync() hides it on occupied workspaces.
        Main.uiGroup.set_child_above_sibling(this.launcher, global.window_group);
        this._renderApps();
    }

    _renderApps() {
        if (!this._appGrid)
            return;
        this._appGrid.destroy_all_children();
        const query = this.search.get_text().trim().toLocaleLowerCase();
        const matches = this.apps.filter(app => {
            const info = app.get_app_info();
            const haystack = [app.get_name(), app.get_id(), info?.get_description(),
                ...(info?.get_keywords() ?? [])].join(' ').toLocaleLowerCase();
            return query.split(/\s+/).every(word => haystack.includes(word));
        });
        this.results = matches.slice(0, this._columns * this._rows);
        this._selected = 0;
        this._appButtons = [];
        for (const [index, app] of this.results.entries()) {
            const button = new St.Button({style_class: 'notchboard-app', can_focus: true,
                accessible_name: `Open ${app.get_name()}`, width: this._tileWidth, height: 100});
            button.set_position(index % this._columns * (this._tileWidth + 10),
                Math.floor(index / this._columns) * 110);
            const content = new St.BoxLayout({vertical: true, style_class: 'notchboard-app-content'});
            const icon = app.create_icon_texture(42);
            icon.x_align = Clutter.ActorAlign.CENTER;
            content.add_child(icon);
            content.add_child(new St.Label({text: app.get_name(), style_class: 'notchboard-app-label',
                x_align: Clutter.ActorAlign.CENTER, width: this._tileWidth - 16}));
            button.set_child(content);
            button.connect('clicked', () => this.launch(app));
            this._appGrid.add_child(button);
            this._appButtons.push(button);
        }
        this._launcherFooter.text = matches.length === 0 ? 'No apps found. Try a different search.' :
            query ? `${matches.length} matching apps  ·  Arrow keys select  ·  Enter opens` :
                'Favorites & frequently used  ·  Type to find any app  ·  Enter opens';
        this._highlightApp();
    }

    _highlightApp() {
        this._appButtons.forEach((button, index) => {
            if (index === this._selected)
                button.add_style_pseudo_class('selected');
            else
                button.remove_style_pseudo_class('selected');
        });
    }

    launch(app) {
        try {
            const workspace = global.workspace_manager.get_active_workspace_index();
            this.owner._mapPinned = false;
            this.owner._hideMap(true);
            this._launcherFooter.text = `Opening ${app.get_name()}…`;
            if (app.can_open_new_window())
                app.open_new_window(workspace);
            else
                app.activate_full(workspace, global.get_current_time());
        } catch (error) {
            this._launcherFooter.text = `Could not open ${app.get_name()}. Try again.`;
            console.error(`[Notchboard] launch: ${error.stack ?? error}`);
        }
    }

    goEmpty() {
        const wm = global.workspace_manager;
        let target = nearestEmpty(wm.get_active_workspace_index(), this.owner._occupied(), wm.n_workspaces);
        if (target < 0 && wm.n_workspaces < 36) {
            this.owner._setCount(wm.n_workspaces + COLUMNS);
            target = nearestEmpty(wm.get_active_workspace_index(), this.owner._occupied(), wm.n_workspaces);
        }
        if (target >= 0) {
            this.owner._hideMap(true);
            wm.get_workspace_by_index(target).activate(global.get_current_time());
            this.sync();
            this.search?.grab_key_focus();
        } else {
            Main.notify('Notchboard is full', 'Close a window to free a cell.');
        }
    }

    sync() {
        if (this._destroyed)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        const occupied = this.owner._occupied();
        const hidden = Main.sessionMode.isLocked || Main.overview.visible;
        this._hidePanel();
        this._syncAi();
        this._syncReveal();
        if (Main.sessionMode.isLocked) {
            this.bell.menu.close();
            this.airpods.menu.close();
        }
        this.owner._syncOverlayCompositing();
        const row = Math.floor(active / COLUMNS);
        const rows = Math.min(3, Math.ceil(wm.n_workspaces / COLUMNS));
        const firstRow = Math.min(Math.max(0, row - 1), Math.ceil(wm.n_workspaces / COLUMNS) - rows);
        this._mini.destroy_all_children();
        for (let i = firstRow * COLUMNS; i < (firstRow + rows) * COLUMNS; i++) {
            const dot = new St.Widget({width: 8, height: 5,
                style_class: `notchboard-dot${occupied.has(i) ? ' occupied' : ''}${i === active ? ' active' : ''}`});
            dot.set_position(i % COLUMNS * 11, (Math.floor(i / COLUMNS) - firstRow) * 8 + (rows === 2 ? 4 : 0));
            this._mini.add_child(dot);
        }
        this._position.text = `${row + 1} · ${active % COLUMNS + 1}    ${occupied.has(active) ? 'Window' : 'New space'}`;
        if (this._lastActive !== null && this._lastActive !== active)
            this._pulseIsland();
        this._lastActive = active;
        this._positionNotch();
        const empty = !occupied.has(active) && !wm.get_active_workspace().list_windows().some(window =>
            !window.is_on_all_workspaces() && !window.is_override_redirect() &&
            (window.get_transient_for() || window.get_window_type() === Meta.WindowType.NORMAL));
        if (hidden || !empty) {
            if (this.launcher?.visible) {
                const focus = global.stage.get_key_focus();
                if (focus && this.launcher.contains(focus))
                    global.stage.set_key_focus(null);
                this.launcher.hide();
            }
            return;
        }
        if (!this.launcher)
            this._buildLauncher(monitor);
        this._launcherSubtitle.text = `Workspace ${row + 1}, ${active % COLUMNS + 1}  ·  Choose an app to begin`;
        const justAppeared = !this.launcher.visible;
        if (justAppeared)
            this.search.set_text('');
        this.launcher.remove_transition('opacity');
        this.launcher.opacity = 255;
        this.launcher.show();
        const [, height] = this.launcher.get_preferred_height(this.launcher.width);
        this.launcher.set_position(Math.round(monitor.x + (monitor.width - this.launcher.width) / 2),
            Math.round(monitor.y + (monitor.height - height) / 2 + 20));
        if (justAppeared) {
            this.launcher.translation_y = 10;
            this.launcher.ease({translation_y: 0, duration: this.owner._duration(),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            this.search.grab_key_focus();
        }
    }

    _destroyLauncher() {
        this.launcher?.destroy();
        this.launcher = this.search = this._appGrid = null;
    }

    destroy() {
        this._destroyed = true;
        this._restoreAi();
        for (const [object, id] of this._signals) {
            if (!(object instanceof GObject.Object) || GObject.signal_handler_is_connected(object, id))
                object.disconnect(id);
        }
        this._signals = [];
        if (this._islandId)
            GLib.source_remove(this._islandId);
        this._islandId = 0;
        if (this._alertId)
            GLib.source_remove(this._alertId);
        this._alertId = 0;
        if (this._concealId)
            GLib.source_remove(this._concealId);
        this._concealId = 0;
        this._edge.destroy();
        this._destroyLauncher();
        this.battery.destroy();
        this.airpods.destroy();
        this.bell.destroy();
        this.notch.destroy();
        this._wallClock = this._clockSettings = null;
        for (const [data, original] of this._panelState?.struts ?? []) {
            if (Main.layoutManager._trackedActors.includes(data))
                data.affectsStruts = original;
        }
        if (this._panelState)
            Main.layoutManager.panelBox.visible = this._panelState.visible;
        for (const [actor, state] of this._docks) {
            actor.disconnect(state.visibleId);
            actor.disconnect(state.allocationId);
            actor.disconnect(state.destroyId);
            for (const [data, original] of state.struts) {
                if (Main.layoutManager._trackedActors.includes(data))
                    data.affectsStruts = original;
            }
            actor.visible = state.visible;
        }
        this._docks.clear();
        Main.layoutManager._queueUpdateRegions();
    }
}
