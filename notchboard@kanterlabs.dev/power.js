import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {EAR, EDGE, HIDE_MARGIN, IslandEars} from './desktop.js';

const STEP = 0.05;
const PEEK_MS = 1500;
const LOGOUT_INHIBIT = 1;
// One MPRIS watcher per Shell session: its D-Bus proxies outlive a runtime, so
// hot reloads reuse it rather than leaving a stale watcher behind each time.
const MEDIA = Symbol.for('notchboard-mpris');
// gnome-session's end-session dialog types this island answers itself; update
// and upgrade restarts keep GNOME's dialog with its install checkbox.
const CONFIRM = {
    0: {title: 'Log out?', verb: 'Log Out', signal: 'ConfirmedLogout', style: 'logout', rgb: [0.78, 0.78, 0.8]},
    1: {title: 'Shut down?', verb: 'Shut Down', signal: 'ConfirmedShutdown', style: 'shutdown', rgb: [1, 0.23, 0.19]},
    2: {title: 'Restart?', verb: 'Restart', signal: 'ConfirmedReboot', style: 'restart', rgb: [0.04, 0.52, 1]},
};

function sessionCall(path, method) {
    return new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.SessionManager', path,
        'org.gnome.SessionManager.Inhibitor', method, null, null, Gio.DBusCallFlags.NONE, 2000, null,
        (connection, result) => {
            try {
                resolve(connection.call_finish(result).deepUnpack()[0]);
            } catch (error) {
                reject(error);
            }
        }));
}

function uptime() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/uptime');
        const minutes = Math.floor(parseFloat(new TextDecoder().decode(bytes)) / 60);
        const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
        return days ? `Up ${days} d ${hours} h` : hours ? `Up ${hours} h ${minutes % 60} min` : `Up ${minutes} min`;
    } catch (_) {
        return '';
    }
}

// Headphones get their own icon and a green volume line, like AirPods' ring.
function isHeadphones(stream) {
    return !!stream && (['headset', 'headphone', 'hands-free'].includes(stream.get_form_factor()) ||
        stream.get_name()?.startsWith('bluez_'));
}

// The second island: power and sound in the bottom-left corner. It follows the
// top island's visibility, including the hide setting and edge peek.
export class PowerIsland {
    constructor(desktop) {
        this._desktop = desktop;
        this.revealed = true;
        this._peek = false;
        this.confirming = null;
        this._actions = SystemActions.getDefault();
        this._control = Volume.getMixerControl();
        this._build();
        this._buildMenu();
        this._actions.connectObject(
            'notify::can-lock-screen', () => this._syncActions(),
            'notify::can-suspend', () => this._syncActions(),
            'notify::can-restart', () => this._syncActions(),
            'notify::can-power-off', () => this._syncActions(),
            'notify::can-logout', () => this._syncActions(), this);
        this._control.connectObject(
            'state-changed', () => this._syncStreams(),
            'default-sink-changed', () => this._syncStreams(),
            'default-source-changed', () => this._syncStreams(),
            'stream-added', () => this._syncDevices(),
            'stream-removed', () => this._syncDevices(), this);
        this._media = globalThis[MEDIA] ??= new Mpris.MprisSource();
        this._media.connectObject(
            'player-added', (_source, player) => this._watchPlayer(player),
            'player-removed', () => this._syncMedia(), this);
        for (const player of this._media.players)
            this._watchPlayer(player);
        this._patchShell();
        this._syncActions();
        this._syncStreams();
    }

    _build() {
        this.notch = new St.BoxLayout({style_class: 'notchboard-notch notchboard-power', vertical: true,
            reactive: true, track_hover: true});
        this.button = new St.Button({style_class: 'notchboard-power-button', can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO, accessible_name: 'Power and sound'});
        this._compact = new St.BoxLayout({style_class: 'notchboard-power-box'});
        this._compact.add_child(new St.Icon({icon_name: 'system-shutdown-symbolic',
            style_class: 'notchboard-power-icon', y_align: Clutter.ActorAlign.CENTER}));
        // Volume lives in the expanded island; the pill only names what's playing.
        this._nowPlaying = new St.BoxLayout({style_class: 'notchboard-power-box', visible: false});
        this._nowPlaying.add_child(new St.Widget({style_class: 'notchboard-power-sep', y_align: Clutter.ActorAlign.CENTER}));
        this._nowPlaying.add_child(new St.Icon({icon_name: 'audio-x-generic-symbolic',
            style_class: 'notchboard-power-icon notchboard-media-note', y_align: Clutter.ActorAlign.CENTER}));
        this._nowPlayingLabel = new St.Label({style_class: 'notchboard-power-label notchboard-media-label',
            y_align: Clutter.ActorAlign.CENTER});
        this._nowPlayingLabel.clutter_text.ellipsize = 3;
        this._nowPlaying.add_child(this._nowPlayingLabel);
        this._compact.add_child(this._nowPlaying);
        // Volume-key peek: the pill stretches into a level bar for a moment.
        this._level = new St.BoxLayout({style_class: 'notchboard-power-box notchboard-power-level', visible: false});
        this._levelIcon = new St.Icon({style_class: 'notchboard-power-icon', y_align: Clutter.ActorAlign.CENTER});
        this._level.add_child(this._levelIcon);
        this._levelTrack = new St.Widget({style_class: 'notchboard-power-level-track', y_align: Clutter.ActorAlign.CENTER});
        this._levelFill = new St.Widget({style_class: 'notchboard-power-level-fill'});
        this._levelTrack.add_child(this._levelFill);
        this._level.add_child(this._levelTrack);
        this._levelLabel = new St.Label({style_class: 'notchboard-power-label', y_align: Clutter.ActorAlign.CENTER});
        this._level.add_child(this._levelLabel);
        const content = new St.BoxLayout();
        content.add_child(this._compact);
        content.add_child(this._level);
        this.button.set_child(content);
        this.button.connect('clicked', (_button, clicked) => {
            if (clicked === Clutter.BUTTON_MIDDLE)
                this._toggleMute();
            else
                this.toggle();
        });
        this.button.connect('scroll-event', (_actor, event) => this._scroll(event));
        const status = new St.BoxLayout();
        status.add_child(this.button);
        status.add_child(this._desktop.airpods.button);
        this.notch.add_child(status);
        this.notch.add_child(this._desktop.battery.track);
        this._levelTrack.connect('notify::width', () => this._paintLevel());
        this.notch.connectObject(
            'notify::width', () => this.position(),
            'notify::height', () => this.position(),
            'notify::hover', () => this._queueConceal(), this);
        Main.layoutManager.addTopChrome(this.notch, {affectsInputRegion: true, trackFullscreen: false});
        // Fills the bottom-left corner, with ears up the left edge and along the bottom.
        this._ears = new IslandEars(this.notch, [
            {fill: [0, 1], place: (x, y) => [x, y - EAR]},
            {fill: [0, 1], place: (x, y, w, h) => [x + w, y + h - EAR]},
        ]);
        this._edge = new St.Widget({reactive: true, track_hover: true, visible: false, height: EDGE});
        this._edge.connect('notify::hover', () => {
            if (this._edge.hover && this._desktop._hidden()) {
                this._peek = true;
                this.syncReveal();
            } else {
                this._queueConceal();
            }
        });
        Main.layoutManager.addTopChrome(this._edge, {affectsInputRegion: true, trackFullscreen: false});
    }

    _buildMenu() {
        this.menu = new PopupMenu.PopupMenu(this.button, 0, St.Side.BOTTOM);
        // Grow from the pill's left edge, so the slab lines up with the corner.
        this.menu.setSourceAlignment(0);
        this.menu.actor.add_style_class_name('notchboard-bell-menu');
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        this._manager = new PopupMenu.PopupMenuManager(this.button);
        this._manager.addMenu(this.menu);
        this._panel = new St.BoxLayout({vertical: true, style_class: 'notchboard-bell-panel notchboard-power-panel'});
        this._panel.add_child(this._desktop.battery.label);
        this._buildMediaCard();
        this._panel.add_child(this._mediaCard);
        this._soundLabel = new St.Label({text: 'SOUND', style_class: 'notchboard-bell-group'});
        this._panel.add_child(this._soundLabel);
        this._output = this._slider('Volume');
        this._input = this._slider('Microphone');
        this._panel.add_child(this._output.row);
        this._panel.add_child(this._input.row);
        this._devices = new St.BoxLayout({vertical: true, style_class: 'notchboard-power-devices'});
        this._panel.add_child(this._devices);
        const tiles = new St.BoxLayout({style_class: 'notchboard-power-tiles'});
        tiles.layout_manager.homogeneous = true;
        this._tiles = {
            lock: this._tile('Lock', 'system-lock-screen-symbolic', () => this._run(() => this._actions.activateLockScreen())),
            suspend: this._tile('Sleep', 'weather-clear-night-symbolic', () => this._run(() => this._actions.activateSuspend())),
            restart: this._tile('Restart', 'system-reboot-symbolic', () => this._request(() => this._actions.activateRestart())),
            power: this._tile('Shut Down', 'system-shutdown-symbolic', () => this._request(() => this._actions.activatePowerOff()), 'danger'),
        };
        for (const tile of Object.values(this._tiles))
            tiles.add_child(tile);
        this._panel.add_child(tiles);
        const footer = new St.BoxLayout({style_class: 'notchboard-bell-footer'});
        this._uptime = new St.Label({style_class: 'notchboard-power-uptime', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._uptime);
        this._logout = new St.Button({label: 'Log Out…', style_class: 'notchboard-bell-pill', can_focus: true});
        this._logout.connect('clicked', () => this._request(() => this._actions.activateLogout()));
        footer.add_child(this._logout);
        this._panel.add_child(footer);
        this.menu.box.add_child(this._panel);
        this._buildConfirm();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this.button.add_style_pseudo_class('checked');
            } else {
                this.button.remove_style_pseudo_class('checked');
                // Dismissing the island answers gnome-session like Cancel.
                if (this.confirming)
                    this._answer(null);
                this._showView(false);
            }
            this._queueConceal();
        });
    }

    _buildMediaCard() {
        this._mediaCard = new St.BoxLayout({style_class: 'notchboard-media-card', visible: false});
        this._mediaArt = new St.Icon({style_class: 'notchboard-media-art', y_align: Clutter.ActorAlign.CENTER});
        this._mediaCard.add_child(this._mediaArt);
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._mediaTitle = new St.Label({style_class: 'notchboard-media-title'});
        this._mediaArtist = new St.Label({style_class: 'notchboard-media-artist'});
        for (const label of [this._mediaTitle, this._mediaArtist]) {
            label.clutter_text.ellipsize = 3;
            titles.add_child(label);
        }
        this._mediaCard.add_child(titles);
        const control = (icon, name, action) => {
            const button = new St.Button({style_class: 'notchboard-media-control', can_focus: true,
                accessible_name: name, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: icon, icon_size: 16})});
            button.connect('clicked', () => action(this._player));
            this._mediaCard.add_child(button);
            return button;
        };
        this._mediaPrev = control('media-skip-backward-symbolic', 'Previous', p => p?.previous());
        this._mediaPlay = control('media-playback-start-symbolic', 'Play or pause', p => p?.playPause());
        this._mediaNext = control('media-skip-forward-symbolic', 'Next', p => p?.next());
    }

    _watchPlayer(player) {
        player.connectObject('changed', () => this._syncMedia(), this);
        this._syncMedia();
    }

    // The playing player wins; otherwise the last one with a track, paused.
    _syncMedia() {
        if (this._destroyed)
            return;
        const players = this._media.players.filter(p => p.trackTitle);
        const player = this._player = players.find(p => p.status === 'Playing') ?? players.at(-1) ?? null;
        const playing = player?.status === 'Playing';
        const artists = player?.trackArtists?.filter(Boolean).join(', ') ?? '';
        const title = player?.trackTitle ?? '';
        const was = this._nowPlaying.visible;
        this._nowPlaying.visible = playing;
        this._nowPlayingLabel.text = artists ? `${title} · ${artists}` : title;
        this.button.accessible_name = playing ? `Power and sound, playing ${this._nowPlayingLabel.text}` : 'Power and sound';
        this._mediaCard.visible = !!player;
        if (player) {
            this._mediaTitle.text = title;
            this._mediaArtist.text = artists || player.app?.get_name() || '';
            this._mediaArtist.visible = !!this._mediaArtist.text;
            const url = player.trackCoverUrl;
            this._mediaArt.gicon = url ? new Gio.FileIcon({file: Gio.File.new_for_uri(url)})
                : player.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
            this._mediaPlay.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            this._mediaPrev.reactive = player.canGoPrevious;
            this._mediaNext.reactive = player.canGoNext;
            this._mediaPrev.opacity = player.canGoPrevious ? 255 : 90;
            this._mediaNext.opacity = player.canGoNext ? 255 : 90;
        }
        if (was !== playing && !this._level.visible)
            this._resize();
    }

    // Ease the pill between widths when its contents change.
    _resize() {
        const notch = this.notch;
        if (!notch.get_stage() || !notch.visible)
            return;
        const from = notch.width;
        notch.remove_transition('width');
        notch.width = -1;
        const [, to] = notch.get_preferred_width(-1);
        notch.width = from;
        notch.ease({width: to, duration: this._desktop.owner._duration() ? 220 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: () => { notch.width = -1; }});
    }

    _slider(name) {
        const row = new St.BoxLayout({style_class: 'notchboard-power-row'});
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        const slider = new Slider.Slider(0);
        slider.add_style_class_name('notchboard-power-slider');
        slider.accessible_name = name;
        slider.x_expand = true;
        const icon = new St.Icon({style_class: 'notchboard-power-slider-icon', x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER, reactive: false});
        holder.add_child(slider);
        holder.add_child(icon);
        row.add_child(holder);
        const value = new St.Label({style_class: 'notchboard-power-pct', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(value);
        const entry = {row, slider, icon, value, stream: null};
        slider.connect('notify::value', () => {
            if (!this._syncing && entry.stream)
                this._setVolume(entry.stream, slider.value);
        });
        return entry;
    }

    _tile(label, iconName, action, extra = '') {
        const tile = new St.Button({style_class: `notchboard-power-tile ${extra}`, can_focus: true,
            x_expand: true, accessible_name: label});
        const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Bin({style_class: 'notchboard-power-disc', x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16})}));
        box.add_child(new St.Label({text: label, style_class: 'notchboard-power-tile-label',
            x_align: Clutter.ActorAlign.CENTER}));
        tile.set_child(box);
        tile.connect('clicked', action);
        return tile;
    }

    _buildConfirm() {
        this._confirm = new St.BoxLayout({vertical: true, style_class: 'notchboard-bell-panel notchboard-power-panel',
            visible: false});
        const top = new St.BoxLayout({style_class: 'notchboard-power-confirm'});
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._ring = new St.DrawingArea({width: 54, height: 54});
        this._ring.connect('repaint', () => this._paintRing());
        this._count = new St.Label({style_class: 'notchboard-power-count', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER});
        holder.add_child(this._ring);
        holder.add_child(this._count);
        top.add_child(holder);
        const titles = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._confirmTitle = new St.Label({style_class: 'notchboard-power-confirm-title'});
        this._confirmBody = new St.Label({style_class: 'notchboard-power-confirm-body'});
        this._confirmBody.clutter_text.line_wrap = true;
        titles.add_child(this._confirmTitle);
        titles.add_child(this._confirmBody);
        top.add_child(titles);
        this._confirm.add_child(top);
        const choices = new St.BoxLayout({style_class: 'notchboard-power-choices'});
        choices.layout_manager.homogeneous = true;
        this._cancel = new St.Button({label: 'Cancel', style_class: 'notchboard-power-choice', can_focus: true,
            x_expand: true});
        this._cancel.connect('clicked', () => this._answer(null));
        this._go = new St.Button({style_class: 'notchboard-power-choice', can_focus: true, x_expand: true});
        this._go.connect('clicked', () => this._answer(this.confirming?.signal));
        choices.add_child(this._cancel);
        choices.add_child(this._go);
        this._confirm.add_child(choices);
        this.menu.box.add_child(this._confirm);
    }

    _showView(confirm) {
        this._panel.visible = !confirm;
        this._confirm.visible = confirm;
    }

    // Replace GNOME's centre-screen volume OSD and end-session dialog with the
    // island. Both stay GNOME's own when the island cannot be seen.
    _patchShell() {
        const osd = Main.osdWindowManager;
        const handle = (original, args, icon) => {
            const names = icon instanceof Gio.ThemedIcon ? icon.get_names() : [];
            if (names.some(name => name.startsWith('audio-volume')) && this.peekVolume())
                return;
            original.apply(osd, args);
        };
        const showAll = osd.showAll, showOne = osd.showOne;
        osd.showAll = (...args) => handle(showAll, args, args[0]);
        osd.showOne = (...args) => handle(showOne, args, args[1]);
        this._osd = osd;
        const dialog = Main.endSessionDialog;
        if (!dialog)
            return;
        const open = dialog.OpenAsync, close = dialog.Close;
        dialog.OpenAsync = async (parameters, invocation) => {
            const [type, , seconds, inhibitors] = parameters;
            if (this._destroyed || !(type in CONFIRM) || Main.sessionMode.isLocked || await this._updatePending(dialog)) {
                this.menu.close();
                return open.call(dialog, parameters, invocation);
            }
            invocation.return_value(null);
            this.openConfirm(type, seconds, inhibitors);
        };
        dialog.Close = (...args) => {
            if (!this.confirming)
                return close.apply(dialog, args);
            this._stopCountdown();
            this.confirming = null;
            this.menu.close();
            return undefined;
        };
        this._dialog = dialog;
    }

    async _updatePending(dialog) {
        if (!dialog._pkOfflineProxy)
            return false;
        try {
            const info = await dialog._getUpdateInfo();
            return !!(info.UpdateTriggered || info.UpgradeTriggered || info.UpdatePrepared);
        } catch (_) {
            return false;
        }
    }

    _unpatchShell() {
        if (this._osd) {
            delete this._osd.showAll;
            delete this._osd.showOne;
        }
        if (this._dialog) {
            delete this._dialog.OpenAsync;
            delete this._dialog.Close;
        }
        this._osd = this._dialog = null;
    }

    _run(action) {
        this.menu.close();
        try {
            action();
        } catch (error) {
            console.error(`[Notchboard] power: ${error.message}`);
        }
    }

    // gnome-session answers with an end-session request, shown by openConfirm.
    _request(action) {
        try {
            action();
        } catch (error) {
            console.error(`[Notchboard] power: ${error.message}`);
            this.menu.close();
        }
    }

    openConfirm(type, seconds, inhibitors = []) {
        const kind = CONFIRM[type];
        this._desktop.airpods.menu.close();
        this._stopCountdown();
        this.confirming = {...kind, seconds, started: GLib.get_monotonic_time(), busy: inhibitors.length > 0};
        this._confirmTitle.text = kind.title;
        this._go.label = kind.verb;
        this._go.set_style_class_name(`notchboard-power-choice ${kind.style}`);
        this._showView(true);
        this._syncCountdown();
        // While hidden this is a peek, which folds away like any other.
        if (this._desktop._hidden())
            this._peek = true;
        this.syncReveal(true);
        if (!this.menu.isOpen)
            this.menu.open();
        this._cancel.grab_key_focus();
        // Apps that hold a logout inhibitor are named and stop the countdown.
        if (inhibitors.length) {
            const confirming = this.confirming;
            this._busyApps(inhibitors).then(names => {
                if (this.confirming !== confirming || this._destroyed)
                    return;
                confirming.busy = names.length > 0;
                confirming.names = names;
                if (!confirming.busy)
                    confirming.started = GLib.get_monotonic_time();
                this._syncCountdown();
                this._startCountdown();
            });
        } else {
            this._startCountdown();
        }
    }

    async _busyApps(paths) {
        const names = [];
        for (const path of paths) {
            try {
                if (!((await sessionCall(path, 'GetFlags')) & LOGOUT_INHIBIT))
                    continue;
                const id = await sessionCall(path, 'GetAppId');
                const app = Shell.AppSystem.get_default().lookup_app(id.endsWith('.desktop') ? id : `${id}.desktop`);
                names.push(app?.get_name() ?? id);
            } catch (_) {
                // gnome-session can hand over inhibitors that have already gone.
            }
        }
        return names;
    }

    _remaining() {
        const c = this.confirming;
        return c ? Math.max(0, c.seconds - (GLib.get_monotonic_time() - c.started) / 1e6) : 0;
    }

    _startCountdown() {
        this._stopCountdown();
        if (!this.confirming || this.confirming.busy || this.confirming.seconds <= 0)
            return;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._syncCountdown();
            if (this._remaining() > 0)
                return GLib.SOURCE_CONTINUE;
            this._tickId = 0;
            this._answer(this.confirming?.signal);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopCountdown() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    _syncCountdown() {
        const c = this.confirming;
        if (!c)
            return;
        const left = Math.ceil(this._remaining());
        const action = {ConfirmedShutdown: 'Shutting down', ConfirmedReboot: 'Restarting',
            ConfirmedLogout: 'Logging out'}[c.signal];
        this._count.text = c.busy ? '!' : `${left}`;
        this._confirmBody.text = !c.busy ? `${action} automatically in ${left} s.`
            : c.names?.length ? `${c.names.length > 1 ? `${c.names[0]} and ${c.names.length - 1} more are`
                : `${c.names[0]} is`} busy and may lose unsaved work.`
                : 'Checking for unsaved work…';
        this._ring.queue_repaint();
    }

    _paintRing() {
        const cr = this._ring.get_context();
        const [w, h] = this._ring.get_surface_size();
        const width = 5, radius = Math.min(w, h) / 2 - width / 2;
        cr.setLineWidth(width);
        cr.setSourceRGBA(0.17, 0.17, 0.18, 1);
        cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
        cr.stroke();
        const c = this.confirming;
        if (c) {
            const fraction = c.busy || c.seconds <= 0 ? 1 : this._remaining() / c.seconds;
            cr.setSourceRGBA(...c.rgb, 1);
            cr.setLineCap(1);
            cr.arc(w / 2, h / 2, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.01, fraction));
            cr.stroke();
        }
        cr.$dispose();
    }

    // Report the choice the way GNOME's own dialog does, then fold away.
    _answer(signal) {
        const dbus = this._dialog?._dbusImpl;
        this._stopCountdown();
        if (!this.confirming)
            return;
        this.confirming = null;
        if (signal) {
            dbus?.emit_signal(signal, null);
        } else {
            dbus?.emit_signal('Canceled', null);
            dbus?.emit_signal('Closed', null);
        }
        this.menu.close();
        this._queueConceal();
    }

    toggle() {
        if (this.menu.isOpen) {
            this.menu.close();
            return;
        }
        this._showView(false);
        this._desktop.airpods.menu.close();
        this._uptime.text = uptime();
        this._syncDevices();
        this.menu.open();
    }

    _syncActions() {
        const a = this._actions;
        this._tiles.lock.visible = a.can_lock_screen;
        this._tiles.suspend.visible = a.can_suspend;
        this._tiles.restart.visible = a.can_restart;
        this._tiles.power.visible = a.can_power_off;
        this._logout.visible = a.can_logout;
    }

    _syncStreams() {
        if (this._destroyed)
            return;
        for (const [entry, stream] of [[this._output, this._control.get_default_sink()],
            [this._input, this._control.get_default_source()]]) {
            if (entry.stream === stream)
                continue;
            entry.stream?.disconnectObject(this);
            entry.stream = stream;
            stream?.connectObject(
                'notify::volume', () => this._render(),
                'notify::is-muted', () => this._render(),
                'notify::port', () => this._render(), this);
        }
        this._render();
        this._syncDevices();
    }

    _fraction(stream) {
        return !stream || stream.is_muted ? 0 : stream.volume / this._control.get_vol_max_norm();
    }

    _volumeIconName(stream) {
        const fraction = this._fraction(stream);
        if (!stream || fraction <= 0)
            return 'audio-volume-muted-symbolic';
        if (isHeadphones(stream))
            return 'audio-headphones-symbolic';
        return fraction < 0.34 ? 'audio-volume-low-symbolic' : fraction < 0.67
            ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
    }

    _render() {
        if (this._destroyed)
            return;
        const stream = this._output.stream;
        const fraction = this._fraction(stream);
        const percent = Math.round(fraction * 100);
        const muted = !stream || fraction <= 0;
        this._levelIcon.icon_name = this._volumeIconName(stream);
        this._levelLabel.text = muted ? '0' : `${percent}`;
        this._syncing = true;
        for (const [entry, icon] of [[this._output, this._volumeIconName(stream)],
            [this._input, 'audio-input-microphone-symbolic']]) {
            const value = this._fraction(entry.stream);
            entry.row.visible = !!entry.stream;
            entry.slider.value = Math.min(1, value);
            entry.value.text = `${Math.round(value * 100)}%`;
            entry.icon.icon_name = icon;
            if (value < 0.12)
                entry.icon.add_style_class_name('low');
            else
                entry.icon.remove_style_class_name('low');
        }
        this._syncing = false;
        this._soundLabel.visible = this._output.row.visible || this._input.row.visible;
        this._paintLevel();
    }

    _paintLevel() {
        const fraction = Math.min(1, this._fraction(this._output.stream));
        this._levelFill.width = Math.round(this._levelTrack.width * fraction);
    }

    _syncDevices() {
        if (this._destroyed || !this._devices)
            return;
        this._devices.destroy_all_children();
        const current = this._control.get_default_sink();
        const sinks = this._control.get_sinks();
        this._devices.visible = sinks.length > 1;
        for (const sink of sinks) {
            const row = new St.Button({style_class: 'notchboard-power-device', can_focus: true, x_expand: true,
                accessible_name: sink.get_description()});
            if (sink === current)
                row.add_style_pseudo_class('checked');
            const box = new St.BoxLayout({x_expand: true});
            box.add_child(new St.Bin({style_class: 'notchboard-power-device-art', y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: isHeadphones(sink) ? 'audio-headphones-symbolic' : 'audio-speakers-symbolic',
                    icon_size: 14})}));
            box.add_child(new St.Label({text: sink.get_description() ?? sink.get_name(), x_expand: true,
                style_class: 'notchboard-power-device-name', y_align: Clutter.ActorAlign.CENTER}));
            const pods = this._desktop.airpods;
            if (sink.get_name()?.startsWith('bluez_') && pods?.connected) {
                const level = pods.summary().level;
                if (level >= 0)
                    box.add_child(new St.Label({text: `${level}%`, style_class: 'notchboard-power-device-note',
                        y_align: Clutter.ActorAlign.CENTER}));
            }
            if (sink === current)
                box.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'notchboard-power-device-check',
                    y_align: Clutter.ActorAlign.CENTER}));
            row.set_child(box);
            row.connect('clicked', () => this._control.set_default_sink(sink));
            this._devices.add_child(row);
        }
    }

    _setVolume(stream, fraction) {
        const volume = Math.round(Math.max(0, Math.min(1, fraction)) * this._control.get_vol_max_norm());
        if (volume < 1) {
            stream.volume = 0;
            if (!stream.is_muted)
                stream.change_is_muted(true);
        } else {
            stream.volume = volume;
            if (stream.is_muted)
                stream.change_is_muted(false);
        }
        stream.push_volume();
    }

    _toggleMute() {
        const stream = this._output.stream;
        if (!stream)
            return;
        if (stream.is_muted && stream.volume === 0) {
            stream.volume = 0.25 * this._control.get_vol_max_norm();
            stream.push_volume();
        }
        stream.change_is_muted(!stream.is_muted);
    }

    _scroll(event) {
        const stream = this._output.stream;
        if (!stream)
            return Clutter.EVENT_PROPAGATE;
        let delta = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            delta = STEP;
        else if (direction === Clutter.ScrollDirection.DOWN)
            delta = -STEP;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = -event.get_scroll_delta()[1] * STEP;
        if (!delta)
            return Clutter.EVENT_PROPAGATE;
        this._setVolume(stream, Math.min(1, this._fraction(stream)) + delta);
        this.peekVolume();
        return Clutter.EVENT_STOP;
    }

    // Volume keys stretch the compact pill into a level bar, then it settles.
    peekVolume() {
        if (this._destroyed || !this.revealed || !this.notch.visible || this.menu.isOpen || Main.sessionMode.isLocked)
            return false;
        this._render();
        if (!this._level.visible)
            this._morph(true);
        if (this._levelId)
            GLib.source_remove(this._levelId);
        this._levelId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_MS, () => {
            this._levelId = 0;
            this._morph(false);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _morph(level) {
        const notch = this.notch;
        const from = notch.width;
        notch.remove_transition('width');
        this._compact.visible = !level;
        this._level.visible = level;
        notch.width = -1;
        const [, to] = notch.get_preferred_width(-1);
        notch.width = from;
        notch.ease({width: to, duration: this._desktop.owner._duration() ? 220 : 0,
            mode: level ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { notch.width = -1; }});
        this._paintLevel();
    }

    resetPeek() {
        this._peek = false;
    }

    _queueConceal() {
        if (this._concealId)
            GLib.source_remove(this._concealId);
        this._concealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._concealId = 0;
            if (this._peek && !this._edge.hover && !this.notch.hover && !this.menu.isOpen &&
                !this._desktop.airpods.menu.isOpen && !this.confirming) {
                this._peek = false;
                this.syncReveal();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // The same rules as the top island, sliding down out of view instead of up.
    // A pending end-session confirmation keeps it in view.
    syncReveal(instant = false) {
        if (this._destroyed)
            return;
        const locked = Main.sessionMode.isLocked;
        const hidden = this._desktop._hidden();
        this._edge.visible = !locked && hidden;
        const show = !locked && (!hidden || this._peek || !!this.confirming);
        if (show === this.revealed)
            return;
        this.revealed = show;
        const notch = this.notch;
        const offset = notch.height + HIDE_MARGIN;
        const duration = instant || locked || !this._desktop.owner._duration() ? 0 : 240;
        notch.remove_transition('translation-y');
        if (show) {
            if (!notch.visible)
                notch.translation_y = offset;
            notch.show();
            this._desktop.owner._syncOverlayCompositing();
            notch.ease({translation_y: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this.menu.close();
            this._desktop.airpods.menu.close();
            notch.ease({translation_y: offset, duration, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    if (this.revealed || this._destroyed)
                        return;
                    notch.hide();
                    notch.translation_y = 0;
                    this._desktop.owner._syncOverlayCompositing();
                }});
        }
    }

    position() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._destroyed || !this.notch.get_stage())
            return;
        const [, height] = this.notch.get_preferred_height(-1);
        this.notch.set_position(monitor.x, monitor.y + monitor.height - height);
        this._edge.width = Math.max(this.notch.width, 120) + 40;
        this._edge.set_position(monitor.x, monitor.y + monitor.height - EDGE);
    }

    destroy() {
        if (this.confirming)
            this._answer(null);
        this._destroyed = true;
        this._unpatchShell();
        this._stopCountdown();
        for (const id of [this._concealId, this._levelId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._concealId = this._levelId = 0;
        this._actions.disconnectObject(this);
        this._control.disconnectObject(this);
        this._media.disconnectObject(this);
        for (const player of this._media._players?.values() ?? [])
            player.disconnectObject(this);
        this._player = null;
        this._output.stream?.disconnectObject(this);
        this._input.stream?.disconnectObject(this);
        this.menu.destroy();
        this._edge.destroy();
        this._ears.destroy();
        this.notch.destroy();
    }
}
