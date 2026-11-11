import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as RemoteSearch from 'resource:///org/gnome/shell/ui/remoteSearch.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {cellName} from './grid.js';
import {calculate, formatNumber, matchScore, webTarget} from './search.js';

const WIDTH = 640;
const ICON = 28;
// Rows per section. Whatever the screen has no room for is cut from the end.
const LIMIT = {apps: 4, windows: 3, actions: 2, remote: 3};
// Other apps answer over D-Bus, so they are asked once typing pauses.
const REMOTE_DELAY = 140;
const CALCULATOR = 'org.gnome.Calculator.desktop';

// Search that drops from the notch: apps, open windows and their cells, sums,
// system and grid actions, whatever GNOME's search providers offer (files,
// settings, contacts…) and the web. One list, driven from the keyboard.
export class Spotlight {
    constructor(desktop) {
        this._desktop = desktop;
        this._owner = desktop.owner;
        this._open = false;
        this._results = [];
        this._rows = [];
        this._local = [];
        this._remote = new Map();
        this._selected = 0;
        this._generation = 0;
        this._actions = SystemActions.getDefault();
        this._searchSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
        this._searchSettings.connectObject('changed', () => { this._providers = null; }, this);
        Shell.AppSystem.get_default().connectObject('installed-changed', () => { this._providers = null; }, this);
        Main.overview.connectObject('showing', () => this.close(true), this);
        Main.sessionMode.connectObject('updated', () => {
            if (Main.sessionMode.isLocked)
                this.close(true);
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this.close(true), this);
    }

    get visible() {
        return this._open;
    }

    _build() {
        // Covers the stage while open: a click anywhere outside the panel closes.
        this._group = new St.Widget({reactive: true, visible: false});
        this._group.connect('button-press-event', (_actor, event) => this._pressOutside(event));
        this._group.connect('touch-event', (_actor, event) =>
            event.type() === Clutter.EventType.TOUCH_BEGIN ? this._pressOutside(event) : Clutter.EVENT_PROPAGATE);
        this.panel = new St.BoxLayout({vertical: true, style_class: 'notchboard-spotlight', reactive: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0})});
        this.entry = new St.Entry({hint_text: 'Search apps, windows, files and more…', can_focus: true,
            style_class: 'notchboard-spotlight-entry', x_expand: true, accessible_name: 'Search'});
        this.entry.set_primary_icon(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 20}));
        const text = this.entry.clutter_text;
        text.connect('text-changed', () => this._search());
        // Activation follows input-method handling, so Enter still commits a
        // composition before it opens a result.
        text.connect('activate', () => this._activate(this._results[this._selected],
            Clutter.get_current_event()?.get_state() ?? 0));
        text.connect('key-press-event', (_actor, event) => this._onKey(event));
        this.panel.add_child(this.entry);
        this._list = new St.BoxLayout({vertical: true, style_class: 'notchboard-spotlight-list', visible: false});
        this.panel.add_child(this._list);
        this._footer = new St.Label({style_class: 'notchboard-spotlight-hint'});
        this.panel.add_child(this._footer);
        this._group.add_child(this.panel);
        Main.uiGroup.add_child(this._group);
    }

    _pressOutside(event) {
        const [x, y] = event.get_coords();
        const [left, top] = this.panel.get_transformed_position();
        const [width, height] = this.panel.get_transformed_size();
        if (x >= left && x < left + width && y >= top && y < top + height)
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const control = event.get_state() & Clutter.ModifierType.CONTROL_MASK;
        // The entry only reports a plain Enter; Ctrl+Enter asks for a new window.
        if (control && [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(key)) {
            this._activate(this._results[this._selected], event.get_state());
            return Clutter.EVENT_STOP;
        }
        const step = {[Clutter.KEY_Down]: 1, [Clutter.KEY_Up]: -1,
            [Clutter.KEY_Tab]: 1, [Clutter.KEY_ISO_Left_Tab]: -1}[key] ??
            (control ? {[Clutter.KEY_n]: 1, [Clutter.KEY_p]: -1}[key] : undefined);
        if (step === undefined)
            return Clutter.EVENT_PROPAGATE;
        if (this._results.length) {
            this._selected = Math.max(0, Math.min(this._results.length - 1, this._selected + step));
            this._moved = true;
            this._highlight();
        }
        return Clutter.EVENT_STOP;
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (this._open || this._destroyed || !monitor || Main.sessionMode.isLocked || Main.overview.visible)
            return false;
        if (!this._group)
            this._build();
        const group = this._group, panel = this.panel;
        panel.remove_all_transitions();
        group.set_position(0, 0);
        group.set_size(global.stage.width, global.stage.height);
        Main.uiGroup.set_child_above_sibling(group, null);
        group.show();
        // A modal grab sends every key here whatever window has focus, and
        // hands focus back to that window afterwards.
        const grab = Main.pushModal(group, {actionMode: Shell.ActionMode.POPUP});
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            group.hide();
            return false;
        }
        this._grab = grab;
        this._open = true;
        // The search takes the map's place beneath the notch.
        this._owner._hideMap(true);
        this._providers ??= RemoteSearch.loadRemoteSearchProviders(this._searchSettings);
        const anchor = this._desktop.mapAnchor();
        panel.width = Math.min(WIDTH, monitor.width - 64);
        panel.set_position(Math.round(monitor.x + (monitor.width - panel.width) / 2), anchor);
        this._maxRows = Math.max(4, Math.min(11,
            Math.floor((monitor.y + monitor.height - anchor - 150) / 56)));
        this.entry.set_text('');
        this._search();
        if (this._owner._duration()) {
            // Grown out of the notch, as the map is. Only geometry overshoots.
            panel.set({scale_x: this._owner._notchScale(panel.width), scale_y: 0.2, translation_y: -10, opacity: 0});
            panel.ease({scale_x: 1, scale_y: 1, translation_y: 0, duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK});
            panel.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            panel.set({scale_x: 1, scale_y: 1, translation_y: 0, opacity: 255});
        }
        this.entry.grab_key_focus();
        this._owner._syncOverlayCompositing();
        this._desktop._syncIsland();
        return true;
    }

    close(immediate = false) {
        if (!this._open)
            return;
        this._open = false;
        this._cancelSearch();
        this._remote.clear();
        Main.popModal(this._grab);
        this._grab = null;
        const group = this._group, panel = this.panel;
        const done = () => {
            if (this._open || this._destroyed)
                return;
            group.hide();
            this._owner._syncOverlayCompositing();
            this._desktop._syncIsland();
        };
        panel.remove_all_transitions();
        if (immediate || !this._owner._duration()) {
            done();
            return;
        }
        panel.ease({scale_x: this._owner._notchScale(panel.width), scale_y: 0.2, translation_y: -10,
            duration: 150, mode: Clutter.AnimationMode.EASE_IN_CUBIC, onComplete: done});
        panel.ease({opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_IN_QUAD});
    }

    _cancelSearch() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._remoteId)
            GLib.source_remove(this._remoteId);
        this._remoteId = 0;
    }

    _search() {
        if (!this._open)
            return;
        this._cancelSearch();
        const query = this.entry.get_text().trim();
        this._query = query;
        this._moved = false;
        this._local = query ? this._localSections(query) : [];
        // Until the providers answer again, keep what still matches by name
        // rather than emptying the list on every keystroke.
        for (const [provider, results] of this._remote) {
            const kept = results.filter(result => matchScore(query, result.title) > 0);
            if (kept.length)
                this._remote.set(provider, kept);
            else
                this._remote.delete(provider);
        }
        this._render();
        if (query.length < 2 || !this._providers?.length)
            return;
        const generation = this._generation;
        this._remoteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMOTE_DELAY, () => {
            this._remoteId = 0;
            const cancellable = this._cancellable = new Gio.Cancellable();
            const terms = query.split(/\s+/);
            for (const provider of this._providers)
                this._ask(provider, terms, generation, cancellable);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _ask(provider, terms, generation, cancellable) {
        try {
            const found = await provider.getInitialResultSet(terms, cancellable) ?? [];
            if (generation !== this._generation)
                return;
            const ids = provider.filterResults(found, LIMIT.remote).slice(0, LIMIT.remote);
            const metas = ids.length ? await provider.getResultMetas(ids, cancellable) : [];
            if (generation !== this._generation)
                return;
            const section = provider.appInfo?.get_name() ?? 'Results';
            const results = metas.filter(meta => meta?.name).map(meta => ({
                key: `${provider.id}:${meta.id}`,
                title: meta.name,
                subtitle: meta.description?.replace(/\s+/g, ' ').trim() || section,
                hint: 'Open',
                icon: () => meta.createIcon?.(ICON) ?? new St.Icon({gicon: provider.appInfo?.get_icon(), icon_size: ICON}),
                activate: () => {
                    provider.activateResult(meta.id, terms);
                    if (meta.clipboardText)
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, meta.clipboardText);
                },
            }));
            if (results.length)
                this._remote.set(provider, results);
            else
                this._remote.delete(provider);
            this._render();
        } catch (error) {
            console.error(`[Notchboard] search provider ${provider.id}: ${error.message}`);
        }
    }

    _glyph(iconName) {
        return new St.Bin({style_class: 'notchboard-spotlight-glyph',
            child: new St.Icon({icon_name: iconName, icon_size: 16})});
    }

    _localSections(query) {
        const sections = [];
        const value = calculate(query);
        if (value !== null) {
            const answer = formatNumber(value);
            sections.push({id: 'calculator', title: 'Calculator', score: Infinity, results: [{
                key: 'calculator', title: `= ${answer}`, subtitle: query, hint: 'Copy', answer: true,
                icon: () => this._glyph('accessories-calculator-symbolic'),
                activate: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, answer),
            }]});
        }
        const eligible = app => app.get_windows().filter(window => this._owner._eligible(window));
        const apps = this._desktop.apps.map((app, order) => {
            const info = app.get_app_info();
            const extra = [info?.get_generic_name(), app.get_id().replace(/\.desktop$/, ''),
                info?.get_description(), ...(info?.get_keywords() ?? [])].filter(Boolean).join(' ');
            return {app, order, score: matchScore(query, app.get_name(), extra)};
        }).filter(entry => entry.score > 0)
            // The launcher's order breaks ties: favourites, then most used.
            .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, LIMIT.apps);
        if (apps.length) {
            sections.push({id: 'apps', title: 'Apps', score: apps[0].score, results: apps.map(({app}) => {
                const [window] = eligible(app);
                return {
                    key: `app:${app.get_id()}`, title: app.get_name(), hint: window ? 'Switch' : 'Open',
                    subtitle: window ? `Open in ${cellName(window.get_workspace().index()).toLowerCase()}`
                        : app.get_description() || 'Application',
                    icon: () => app.create_icon_texture(ICON),
                    activate: state => this._launch(app, !!(state & Clutter.ModifierType.CONTROL_MASK)),
                };
            })});
        }
        const tracker = Shell.WindowTracker.get_default();
        const listed = new Set(apps.map(entry => entry.app));
        const windows = global.get_window_actors().map(actor => actor.meta_window)
            .filter(window => this._owner._eligible(window) && window.get_workspace())
            .map(window => {
                const app = tracker.get_window_app(window);
                return {window, app, score: matchScore(query, window.get_title() ?? '', app?.get_name() ?? '')};
            })
            // An app's only window is already reached through the app's own row.
            .filter(({app, score}) => score > 0 && !(listed.has(app) && eligible(app).length === 1))
            .sort((a, b) => b.score - a.score || b.window.get_user_time() - a.window.get_user_time())
            .slice(0, LIMIT.windows);
        if (windows.length) {
            sections.push({id: 'windows', title: 'Windows', score: windows[0].score, results: windows.map(({window, app}) => ({
                key: `window:${window.get_stable_sequence()}`, title: window.get_title() || 'Window', hint: 'Switch',
                subtitle: [app?.get_name(), cellName(window.get_workspace().index())].filter(Boolean).join('  ·  '),
                icon: () => app?.create_icon_texture(ICON) ?? this._glyph('window-symbolic'),
                activate: () => window.get_workspace()?.activate_with_focus(window, global.get_current_time()),
            }))});
        }
        // Two letters are too few to put Sleep or Lock under Enter.
        const actions = query.length < 3 ? [] : this._actionList()
            .map(action => ({action, score: matchScore(query, action.name, action.keywords)}))
            .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, LIMIT.actions);
        if (actions.length) {
            sections.push({id: 'actions', title: 'Actions', score: actions[0].score, results: actions.map(({action}) => ({
                key: `action:${action.name}`, title: action.name, subtitle: action.about, hint: 'Run',
                icon: () => this._glyph(action.icon), activate: action.run,
            }))});
        }
        // The best match leads, whichever kind it is: "lock" locks the screen
        // rather than opening Clocks. Ties keep the order above.
        return sections.sort((a, b) => b.score - a.score);
    }

    // Restart, Shut Down and Log Out are confirmed in the power island, as
    // they are from its own menu.
    _actionList() {
        const system = this._actions;
        const hidden = this._desktop._hidden();
        return [
            {name: 'Lock', keywords: 'screen', about: 'Lock the screen', icon: 'system-lock-screen-symbolic',
                can: system.canLockScreen, run: () => system.activateLockScreen()},
            {name: 'Sleep', keywords: 'suspend standby', about: 'Suspend this computer',
                icon: 'weather-clear-night-symbolic', can: system.canSuspend, run: () => system.activateSuspend()},
            {name: 'Restart', keywords: 'reboot', about: 'Restart this computer', icon: 'system-reboot-symbolic',
                can: system.canRestart, run: () => system.activateRestart()},
            {name: 'Shut Down', keywords: 'power off poweroff shutdown', about: 'Turn this computer off',
                icon: 'system-shutdown-symbolic', can: system.canPowerOff, run: () => system.activatePowerOff()},
            {name: 'Log Out', keywords: 'logout sign out exit session', about: 'End this session',
                icon: 'system-log-out-symbolic', can: system.canLogout, run: () => system.activateLogout()},
            {name: 'New space', keywords: 'empty workspace cell launcher', about: 'Go to the nearest empty cell',
                icon: 'list-add-symbolic', can: true, run: () => this._desktop.goEmpty()},
            {name: 'Pack the grid', keywords: 'reset tidy workspaces windows',
                about: 'Move windows together and remove unused rows',
                icon: 'view-refresh-symbolic', can: true, run: () => this._owner.resetGrid()},
            {name: hidden ? 'Show the islands' : 'Hide the islands', keywords: 'notch island toggle',
                about: hidden ? 'Keep the notch and the corner island on screen' : 'Tuck both islands away until you touch their edge',
                icon: hidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic', can: true,
                run: () => this._desktop.toggleNotch()},
        ].filter(action => action.can);
    }

    _launch(app, newWindow) {
        if (newWindow && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    }

    _sections() {
        const sections = [...this._local];
        const sum = sections.some(section => section.id === 'calculator');
        // In the order GNOME's search settings give them, not the order they answered.
        for (const provider of this._providers ?? []) {
            const results = this._remote.get(provider);
            // GNOME Calculator would repeat the sum just above it.
            if (results && !(sum && provider.id === CALCULATOR))
                sections.push({id: provider.id, title: provider.appInfo?.get_name() ?? 'Results', results});
        }
        return sections;
    }

    _render() {
        const previous = this._moved ? this._results[this._selected]?.key : null;
        const target = this._query ? webTarget(this._query, this._owner._settings.get_string('search-web-url')) : null;
        const web = target && {
            key: 'web', hint: target.address ? 'Open' : 'Search',
            title: target.address ? `Open ${target.label}` : `Search the web for “${target.label}”`,
            subtitle: target.address ? 'In your browser' : target.engine,
            icon: () => this._glyph(target.address ? 'web-browser-symbolic' : 'system-search-symbolic'),
            activate: () => Gio.AppInfo.launch_default_for_uri(target.uri, global.create_app_launch_context(0, -1)),
        };
        let room = this._maxRows - (web ? 1 : 0);
        const shown = [];
        for (const section of this._sections()) {
            const results = section.results.slice(0, Math.max(0, room));
            room -= results.length;
            if (results.length)
                shown.push({...section, results});
        }
        if (web)
            shown.push({id: 'web', title: 'Web', results: [web]});
        this._list.destroy_all_children();
        this._results = [];
        this._rows = [];
        for (const section of shown) {
            this._list.add_child(new St.Label({text: section.title, style_class: 'notchboard-spotlight-section'}));
            for (const result of section.results) {
                const row = this._row(result);
                this._list.add_child(row);
                this._results.push(result);
                this._rows.push(row);
            }
        }
        // New rows arriving leave the selection where the arrows put it.
        const kept = previous ? this._results.findIndex(result => result.key === previous) : -1;
        this._selected = Math.max(0, kept);
        this._list.visible = this._results.length > 0;
        this._footer.text = this._results.length ? '↑ ↓ to choose   ·   Enter to open   ·   Esc to close'
            : this._query ? 'Nothing found' : 'Apps, windows, files, settings, sums and the web';
        this._highlight();
    }

    _row(result) {
        const row = new St.Button({style_class: 'notchboard-spotlight-row', x_expand: true,
            accessible_name: [result.title, result.subtitle].filter(Boolean).join(': ')});
        const box = new St.BoxLayout({style_class: 'notchboard-spotlight-row-box', x_expand: true});
        const icon = result.icon();
        icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: result.title,
            style_class: result.answer ? 'notchboard-spotlight-answer' : 'notchboard-spotlight-title'}));
        if (result.subtitle)
            text.add_child(new St.Label({text: result.subtitle, style_class: 'notchboard-spotlight-subtitle'}));
        box.add_child(text);
        // What Enter does, shown on the selected row only.
        row._hint = new St.Label({text: `${result.hint}  ↵`, style_class: 'notchboard-spotlight-key',
            y_align: Clutter.ActorAlign.CENTER, opacity: 0});
        box.add_child(row._hint);
        row.set_child(box);
        row.connect('clicked', () => this._activate(result, 0));
        return row;
    }

    _highlight() {
        this._rows.forEach((row, index) => {
            const selected = index === this._selected;
            if (selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
            row._hint.opacity = selected ? 255 : 0;
        });
    }

    _activate(result, state) {
        if (!result)
            return;
        // Closing first returns focus to the desktop the result acts on.
        this.close();
        try {
            result.activate(state);
        } catch (error) {
            console.error(`[Notchboard] search: ${error.stack ?? error}`);
        }
    }

    destroy() {
        this.close(true);
        this._destroyed = true;
        this._searchSettings.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._group?.destroy();
        this._group = this.panel = this.entry = this._list = this._footer = null;
        this._providers = null;
        this._remote.clear();
        this._results = [];
        this._rows = [];
    }
}
