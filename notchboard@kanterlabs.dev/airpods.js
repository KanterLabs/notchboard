import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

// EarPort's daemon owns the AirPods connection; the island only reads it and
// forwards noise-control changes. Nothing is auto-started.
const BUS_NAME = 'io.github.anoryth.EarPort';
const OBJECT_PATH = '/io/github/anoryth/EarPort';
const INTERFACE = `<node><interface name="io.github.anoryth.EarPort1">
  <property name="Connected" type="b" access="read"/>
  <property name="DeviceName" type="s" access="read"/>
  <property name="DisplayName" type="s" access="read"/>
  <property name="DeviceModel" type="s" access="read"/>
  <property name="IsHeadphones" type="b" access="read"/>
  <property name="SupportsANC" type="b" access="read"/>
  <property name="SupportsAdaptive" type="b" access="read"/>
  <property name="BatteryLeft" type="i" access="read"/>
  <property name="BatteryRight" type="i" access="read"/>
  <property name="BatteryCase" type="i" access="read"/>
  <property name="ChargingLeft" type="b" access="read"/>
  <property name="ChargingRight" type="b" access="read"/>
  <property name="ChargingCase" type="b" access="read"/>
  <property name="NoiseControlMode" type="s" access="read"/>
  <property name="ConversationalAwareness" type="b" access="read"/>
  <property name="LeftInEar" type="b" access="read"/>
  <property name="RightInEar" type="b" access="read"/>
  <method name="SetNoiseControlMode"><arg type="s" name="mode" direction="in"/></method>
  <method name="SetConversationalAwareness"><arg type="b" name="enabled" direction="in"/></method>
</interface></node>`;
// Proximity-pairing model codes, keyed by EarPort's model names.
const MODELS = {
    'AirPods 1st Gen': 0x0220, 'AirPods 2nd Gen': 0x0F20, 'AirPods 3rd Gen': 0x1320,
    'AirPods 4th Gen': 0x1920, 'AirPods 4th Gen (ANC)': 0x1B20, 'AirPods Pro': 0x0E20,
    'AirPods Pro 2': 0x1420, 'AirPods Pro 2 (USB-C)': 0x2420, 'AirPods Pro 3': 0x2027,
    'AirPods Max': 0x0A20, 'AirPods Max (USB-C)': 0x1F20,
};
const MODES = [['off', 'Off'], ['transparency', 'Transparency'], ['adaptive', 'Adaptive'], ['anc', 'Noise Cancel']];
const LOW = 20;
const GREEN = [0.19, 0.82, 0.35];
const RED = [1, 0.23, 0.19];
const SCAN_MS = 8000;
const RESCAN_S = 300;
const PEEK_MS = 3000;

// Apple's proximity-pairing broadcast (manufacturer 0x004C, type 0x07) carries
// each part's charge in 10% steps; 15 means that part is not reporting.
export function decodeProximity(bytes) {
    if (!bytes || bytes.length < 8 || bytes[0] !== 0x07)
        return null;
    const level = nibble => nibble <= 10 ? nibble * 10 : -1;
    const flip = ((bytes[5] >> 4) & 0x02) === 0;
    const high = bytes[6] >> 4, low = bytes[6] & 0x0f;
    const charge = bytes[7] >> 4;
    return {
        model: bytes[3] << 8 | bytes[4],
        left: level(flip ? high : low),
        right: level(flip ? low : high),
        case: level(bytes[7] & 0x0f),
        chargingLeft: !!(charge & (flip ? 0x02 : 0x01)),
        chargingRight: !!(charge & (flip ? 0x01 : 0x02)),
        chargingCase: !!(charge & 0x04),
    };
}

function dbusCall(bus, path, iface, method, args = null) {
    return new Promise((resolve, reject) => bus.call('org.bluez', path, iface, method, args, null,
        Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                resolve(connection.call_finish(result));
            } catch (error) {
                reject(error);
            }
        }));
}

// Some AirPods (AirPods 4 here) never send battery over EarPort's connection,
// so a short LE scan reads their own broadcast instead.
export class ProximityScanner {
    async scan(model) {
        const bus = Gio.DBus.system;
        const objects = async () => (await dbusCall(bus, '/', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects')).recursiveUnpack()[0];
        const adapter = Object.entries(await objects())
            .find(([, ifaces]) => ifaces['org.bluez.Adapter1']?.Powered)?.[0];
        if (!adapter)
            return null;
        await dbusCall(bus, adapter, 'org.bluez.Adapter1', 'SetDiscoveryFilter',
            new GLib.Variant('(a{sv})', [{Transport: new GLib.Variant('s', 'le'),
                DuplicateData: new GLib.Variant('b', true)}]));
        await dbusCall(bus, adapter, 'org.bluez.Adapter1', 'StartDiscovery');
        // BlueZ forgets RSSI once discovery stops, so read while scanning and
        // stop as soon as the AirPods have been heard.
        let best = null;
        try {
            for (let elapsed = 0; elapsed < SCAN_MS && !best; elapsed += 1000) {
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
                for (const ifaces of Object.values(await objects())) {
                    const device = ifaces['org.bluez.Device1'];
                    const reading = decodeProximity(device?.ManufacturerData?.[0x004c]);
                    if (!reading || (model && reading.model !== model))
                        continue;
                    if (!best || (device.RSSI ?? -127) > best.rssi)
                        best = {...reading, rssi: device.RSSI ?? -127};
                }
            }
        } finally {
            await dbusCall(bus, adapter, 'org.bluez.Adapter1', 'StopDiscovery').catch(() => {});
        }
        return best;
    }
}

function ring(size, width) {
    const area = new St.DrawingArea({width: size, height: size, style_class: 'notchboard-pods-ring',
        y_align: Clutter.ActorAlign.CENTER});
    area.level = -1;
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const radius = Math.min(w, h) / 2 - width / 2;
        cr.setLineWidth(width);
        cr.setSourceRGBA(0.23, 0.23, 0.24, 1);
        cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (area.level >= 0) {
            cr.setSourceRGBA(...(area.level <= LOW ? RED : GREEN), 1);
            cr.setLineCap(1);
            cr.arc(w / 2, h / 2, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.02, area.level / 100));
            cr.stroke();
        }
        cr.$dispose();
    });
    area.setLevel = level => {
        area.level = level;
        area.queue_repaint();
    };
    return area;
}

const text = level => level >= 0 ? `${level}%` : '—';

// AirPods battery and noise control in the island, from EarPort's daemon.
export class AirPodsIndicator {
    constructor(desktop) {
        this._desktop = desktop;
        this._scanner = new ProximityScanner();
        this._broadcast = null;
        this._scannedAt = -Infinity;
        this.connected = false;
        this.button = new St.Button({style_class: 'notchboard-pods', can_focus: true, visible: false,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'AirPods'});
        const box = new St.BoxLayout({style_class: 'notchboard-pods-box'});
        box.add_child(new St.Icon({icon_name: 'audio-headphones-symbolic', style_class: 'notchboard-pods-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        this._ring = ring(16, 3);
        box.add_child(this._ring);
        this._label = new St.Label({style_class: 'notchboard-pods-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        this.button.set_child(box);
        this.button.connect('clicked', () => this.toggle());
        this._buildMenu();
        this._buildPeek();
        this._rescanId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._maybeScan();
            return GLib.SOURCE_CONTINUE;
        });
        const info = Gio.DBusNodeInfo.new_for_xml(INTERFACE).interfaces[0];
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, info,
            BUS_NAME, OBJECT_PATH, info.name, this._cancellable, (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`[Notchboard] AirPods: ${error.message}`);
                    return;
                }
                this._proxy.connectObject(
                    'g-properties-changed', () => this._sync(),
                    'notify::g-name-owner', () => this._sync(), this);
                this._sync(true);
            });
    }

    _buildMenu() {
        this.menu = new PopupMenu.PopupMenu(this.button, 0, St.Side.BOTTOM);
        this.menu.setSourceAlignment(0);
        this.menu.actor.add_style_class_name('notchboard-bell-menu');
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        this._manager = new PopupMenu.PopupMenuManager(this.button);
        this._manager.addMenu(this.menu);
        const panel = new St.BoxLayout({vertical: true, style_class: 'notchboard-bell-panel notchboard-pods-panel'});
        const header = new St.BoxLayout({style_class: 'notchboard-pods-header'});
        const art = new St.Bin({style_class: 'notchboard-pods-art',
            child: new St.Icon({icon_name: 'audio-headphones-symbolic', icon_size: 20})});
        header.add_child(art);
        const titles = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        this._name = new St.Label({style_class: 'notchboard-bell-heading'});
        this._status = new St.Label({style_class: 'notchboard-pods-status'});
        titles.add_child(this._name);
        titles.add_child(this._status);
        header.add_child(titles);
        panel.add_child(header);
        const cells = new St.BoxLayout({style_class: 'notchboard-pods-cells'});
        this._cells = {};
        for (const [key, title] of [['left', 'Left'], ['right', 'Right'], ['case', 'Case']]) {
            const cell = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'notchboard-pods-cell'});
            const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
            const area = ring(38, 3.5);
            const value = new St.Label({style_class: 'notchboard-pods-value',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            holder.add_child(area);
            holder.add_child(value);
            const caption = new St.Label({style_class: 'notchboard-pods-caption', x_align: Clutter.ActorAlign.CENTER});
            cell.add_child(holder);
            cell.add_child(caption);
            cells.add_child(cell);
            this._cells[key] = {cell, area, value, caption, title};
        }
        panel.add_child(cells);
        this._source = new St.Label({style_class: 'notchboard-pods-source'});
        panel.add_child(this._source);
        this._modeLabel = new St.Label({text: 'NOISE CONTROL', style_class: 'notchboard-bell-group'});
        panel.add_child(this._modeLabel);
        this._modes = new St.BoxLayout({style_class: 'notchboard-pods-modes'});
        this._modeButtons = {};
        for (const [mode, label] of MODES) {
            const button = new St.Button({label, style_class: 'notchboard-pods-mode', can_focus: true,
                x_expand: true});
            button.connect('clicked', () => this._call('SetNoiseControlMode', new GLib.Variant('(s)', [mode])));
            this._modes.add_child(button);
            this._modeButtons[mode] = button;
        }
        panel.add_child(this._modes);
        this._awareness = new St.Button({style_class: 'notchboard-bell-row notchboard-pods-toggle',
            can_focus: true, x_expand: true, accessible_name: 'Conversation Awareness'});
        const toggleBox = new St.BoxLayout({x_expand: true});
        toggleBox.add_child(new St.Label({text: 'Conversation Awareness', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER}));
        this._switch = new PopupMenu.Switch(false);
        toggleBox.add_child(this._switch);
        this._awareness.set_child(toggleBox);
        this._awareness.connect('clicked', () => this._call('SetConversationalAwareness',
            new GLib.Variant('(b)', [!this._get('ConversationalAwareness')])));
        panel.add_child(this._awareness);
        const footer = new St.BoxLayout({style_class: 'notchboard-bell-footer'});
        footer.add_child(this._pill('EarPort settings', ['gnome-extensions', 'prefs', 'earport@anoryth.github.io']));
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(this._pill('Bluetooth', ['gnome-control-center', 'bluetooth']));
        panel.add_child(footer);
        this.menu.box.add_child(panel);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.button.add_style_pseudo_class('checked');
            else
                this.button.remove_style_pseudo_class('checked');
            if (open)
                this._desktop.power.menu.close();
            this._desktop.power._queueConceal();
        });
    }

    _pill(label, argv) {
        const button = new St.Button({label, style_class: 'notchboard-bell-pill', can_focus: true});
        button.connect('clicked', () => {
            this.menu.close();
            Util.spawn(argv);
        });
        return button;
    }

    // A connect card that covers the island for a moment, as on iPhone.
    _buildPeek() {
        this._peek = new St.BoxLayout({style_class: 'notchboard-pods-peek', visible: false, opacity: 0});
        const art = new St.Bin({style_class: 'notchboard-pods-peek-art',
            child: new St.Icon({icon_name: 'audio-headphones-symbolic', icon_size: 34})});
        this._peek.add_child(art);
        const titles = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._peekName = new St.Label({style_class: 'notchboard-pods-peek-name'});
        this._peekStatus = new St.Label({style_class: 'notchboard-pods-status'});
        titles.add_child(this._peekName);
        titles.add_child(this._peekStatus);
        this._peek.add_child(titles);
        this._peekCells = {};
        for (const [key, title] of [['left', 'L'], ['right', 'R'], ['case', 'Case']]) {
            const cell = new St.BoxLayout({vertical: true, style_class: 'notchboard-pods-cell'});
            const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
            const area = ring(34, 3.5);
            const value = new St.Label({style_class: 'notchboard-pods-value',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            holder.add_child(area);
            holder.add_child(value);
            cell.add_child(holder);
            const caption = new St.Label({text: title, style_class: 'notchboard-pods-caption',
                x_align: Clutter.ActorAlign.CENTER});
            cell.add_child(caption);
            this._peek.add_child(cell);
            this._peekCells[key] = {cell, area, value, caption, title};
        }
        Main.layoutManager.addTopChrome(this._peek, {affectsInputRegion: false, trackFullscreen: false});
    }

    _get(name) {
        return this._proxy?.get_cached_property(name)?.unpack();
    }

    _call(method, args) {
        this._proxy?.call(method, args, Gio.DBusCallFlags.NONE, -1, null, (proxy, result) => {
            try {
                proxy.call_finish(result);
            } catch (error) {
                console.error(`[Notchboard] AirPods ${method}: ${error.message}`);
            }
        });
    }

    toggle() {
        if (this.menu.isOpen) {
            this.menu.close();
            return;
        }
        this._maybeScan(true);
        this.menu.open();
    }

    // EarPort's exact readings win; the 10%-step broadcast fills the gaps.
    readings() {
        const exact = key => this._get(`Battery${key}`) ?? -1;
        const broadcast = this._broadcast;
        const pick = (key, field) => {
            const value = exact(key);
            if (value >= 0)
                return {level: value, charging: !!this._get(`Charging${key}`), approximate: false};
            const level = broadcast?.[field] ?? -1;
            return {level, charging: level >= 0 && !!broadcast[`charging${key}`], approximate: level >= 0};
        };
        return {left: pick('Left', 'left'), right: pick('Right', 'right'), case: pick('Case', 'case')};
    }

    // The island shows the lowest bud in use, or the lowest bud otherwise.
    summary(readings = this.readings()) {
        const inEar = [this._get('LeftInEar') && readings.left, this._get('RightInEar') && readings.right]
            .filter(r => r && r.level >= 0);
        const buds = (inEar.length ? inEar : [readings.left, readings.right]).filter(r => r.level >= 0);
        if (this._get('IsHeadphones'))
            return readings.left;
        if (!buds.length)
            return {level: -1, charging: false, approximate: false};
        return buds.reduce((low, r) => r.level < low.level ? r : low);
    }

    _maybeScan(force = false) {
        const readings = this.readings();
        const missing = [readings.left, readings.right].some(r => r.level < 0 || r.approximate);
        const now = GLib.get_monotonic_time() / 1e6;
        if (!this.connected || !missing || this._scanning || (!force && now - this._scannedAt < RESCAN_S))
            return;
        this._scanning = true;
        this._scannedAt = now;
        this._scanner.scan(MODELS[this._get('DeviceModel')] ?? null).then(reading => {
            if (this._destroyed)
                return;
            if (reading)
                this._broadcast = reading;
            this._render();
        }).catch(error => {
            console.warn(`[Notchboard] AirPods scan: ${error.message}`);
        }).finally(() => {
            this._scanning = false;
        });
    }

    _sync(initial = false) {
        if (this._destroyed)
            return;
        const connected = !!this._proxy?.get_name_owner() && !!this._get('Connected');
        const arrived = connected && !this.connected && !initial;
        this.connected = connected;
        this.button.visible = connected;
        if (!connected) {
            this._broadcast = null;
            this._scannedAt = -Infinity;
            this.menu.close();
        }
        this._render();
        this._maybeScan();
        if (arrived)
            this.showPeek();
        this._desktop.power.position();
    }

    _paint(cells, readings) {
        const headphones = !!this._get('IsHeadphones');
        for (const [key, {cell, area, value, caption, title}] of Object.entries(cells)) {
            const reading = readings[key];
            cell.visible = !headphones || key === 'left';
            area.setLevel(reading.level);
            value.text = reading.level >= 0 ? `${reading.level}` : '—';
            caption.text = `${headphones ? 'Battery' : title}${reading.charging ? ' ⚡' : ''}`;
        }
    }

    _render() {
        if (this._destroyed)
            return;
        const readings = this.readings();
        const summary = this.summary(readings);
        this._ring.setLevel(summary.level);
        this._label.text = `${text(summary.level)}${summary.charging ? ' ⚡' : ''}`;
        if (summary.level >= 0 && summary.level <= LOW)
            this._label.add_style_class_name('low');
        else
            this._label.remove_style_class_name('low');
        this.button.accessible_name = `AirPods ${text(summary.level)}`;
        const name = this._get('DisplayName') || this._get('DeviceModel') || this._get('DeviceName') || 'AirPods';
        const mode = MODES.find(([key]) => key === this._get('NoiseControlMode'))?.[1] ?? '';
        const left = this._get('LeftInEar'), right = this._get('RightInEar');
        const ears = left && right ? 'both in ear' : left ? 'left in ear' : right ? 'right in ear' : '';
        this._name.text = this._peekName.text = name;
        this._status.text = ['Connected', ears].filter(Boolean).join(' · ');
        this._peekStatus.text = ['Connected', mode].filter(Boolean).join(' · ');
        this._paint(this._cells, readings);
        this._paint(this._peekCells, readings);
        const approximate = Object.values(readings).some(r => r.approximate);
        this._source.visible = approximate;
        this._source.text = 'Approximate (10% steps) from the AirPods’ Bluetooth broadcast';
        const supported = {off: true, transparency: !!this._get('SupportsANC'),
            adaptive: !!this._get('SupportsAdaptive'), anc: !!this._get('SupportsANC')};
        for (const [key, button] of Object.entries(this._modeButtons)) {
            button.visible = supported[key];
            if (key === this._get('NoiseControlMode'))
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._modeLabel.visible = this._modes.visible = this._awareness.visible = !!this._get('SupportsANC');
        this._switch.state = !!this._get('ConversationalAwareness');
    }

    showPeek() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._desktop._hidden() || Main.sessionMode.isLocked)
            return;
        const peek = this._peek;
        peek.width = -1;
        const [, natural] = peek.get_preferred_width(-1);
        // Fully cover the island, which can be wider than the card.
        const width = Math.max(natural, this._desktop.power.notch.width + 16);
        peek.width = width;
        const [, height] = peek.get_preferred_height(width);
        peek.set_position(monitor.x + 6, monitor.y + monitor.height - height - 6);
        peek.set_pivot_point(0, 1);
        peek.remove_all_transitions();
        // The island is added after this card, so raise the card over it.
        peek.get_parent()?.set_child_above_sibling(peek, null);
        peek.show();
        peek.scale_x = peek.scale_y = 0.6;
        const duration = this._desktop.owner._duration() ? 260 : 0;
        peek.ease({opacity: 255, scale_x: 1, scale_y: 1, duration, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        if (this._peekId)
            GLib.source_remove(this._peekId);
        this._peekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_MS, () => {
            this._peekId = 0;
            peek.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: duration * 0.8,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC, onComplete: () => {
                    if (!this._peekId)
                        peek.hide();
                }});
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        if (this._peekId)
            GLib.source_remove(this._peekId);
        this._peekId = 0;
        GLib.source_remove(this._rescanId);
        this.menu.destroy();
        this._peek.destroy();
        this.button.destroy();
    }
}
