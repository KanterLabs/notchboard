import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

const POLICIES = [MessageTray.NotificationPolicy, MessageTray.NotificationGenericPolicy,
    MessageTray.NotificationApplicationPolicy];
// Shared by every loaded runtime so hot reloads, in any order, patch once and
// restore the original getters exactly once.
const HOLD = Symbol.for('notchboard-banner-hold');
// Bundled glyphs: icon themes such as WhiteSur draw the stock notification
// icon as a monitor rather than a bell.
const ICONS = Gio.File.new_for_uri(import.meta.url.split('?')[0]).get_parent().get_child('icons');
const glyph = name => Gio.FileIcon.new(ICONS.get_child(`${name}.svg`));
const BELL = glyph('notchboard-bell-symbolic');
const MUTED = glyph('notchboard-bell-muted-symbolic');
const RING = [16, -14, 10, -6, 3, 0];

// MessageTray consults policy.showBanners for every banner request and lets
// CRITICAL urgency bypass it, so low-battery style alerts still pop up.
function holdBanners() {
    const state = globalThis[HOLD] ??= {count: 0, originals: new Map()};
    if (state.count++ > 0)
        return;
    for (const policy of POLICIES) {
        const proto = policy.prototype;
        state.originals.set(proto, Object.getOwnPropertyDescriptor(proto, 'showBanners'));
        Object.defineProperty(proto, 'showBanners', {configurable: true, get: () => false});
    }
}

function releaseBanners() {
    const state = globalThis[HOLD];
    if (!state || --state.count > 0)
        return;
    for (const [proto, original] of state.originals) {
        if (original)
            Object.defineProperty(proto, 'showBanners', original);
        else
            delete proto.showBanners;
    }
    delete globalThis[HOLD];
}

// Whether GNOME itself would have shown a banner: honours Do Not Disturb and
// per-app banner settings through the unpatched getter.
function wouldBanner(policy) {
    const originals = globalThis[HOLD]?.originals;
    for (let proto = Object.getPrototypeOf(policy); proto; proto = Object.getPrototypeOf(proto)) {
        const original = originals?.get(proto);
        if (original?.get)
            return original.get.call(policy);
        if (Object.getOwnPropertyDescriptor(proto, 'showBanners'))
            return policy.showBanners;
    }
    return true;
}

function plain(notification) {
    let body = notification.body ?? '';
    if (notification.useBodyMarkup)
        body = body.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return body.replace(/\s+/g, ' ').trim();
}

function age(datetime) {
    const seconds = datetime ? GLib.DateTime.new_now_local().difference(datetime) / 1e6 : 0;
    if (seconds < 60)
        return 'now';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h`;
    return datetime.format('%b %-d');
}

// Banners are replaced by a bell in the island: arrivals ring it and bump an
// unread badge, and clicking it drops down the notifications GNOME is holding.
export class NotificationBell {
    constructor(desktop) {
        this._desktop = desktop;
        this._sources = new Set();
        this._fresh = new Set();
        this._ringGeneration = 0;
        this.unseen = 0;
        holdBanners();
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.button = new St.Button({style_class: 'notchboard-bell', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Notifications'});
        // The count sits beside the bell rather than on it: the island is too
        // short for an iOS-style corner badge without hiding the icon.
        const layers = new St.BoxLayout({style_class: 'notchboard-bell-layers'});
        this._icon = new St.Icon({gicon: BELL, style_class: 'notchboard-bell-icon',
            y_align: Clutter.ActorAlign.CENTER});
        this._icon.set_pivot_point(0.5, 0.15);
        this._badge = new St.Label({style_class: 'notchboard-bell-badge', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        layers.add_child(this._icon);
        layers.add_child(this._badge);
        this.button.set_child(layers);
        this.button.connect('clicked', () => this.toggle());
        this._buildMenu();
        Main.messageTray.connectObject(
            'source-added', (_tray, source) => { this._watch(source); this._sync(); },
            'source-removed', (_tray, source) => { this._unwatch(source); this._sync(); }, this);
        Main.messageTray.getSources().forEach(source => this._watch(source));
        this._settings.connectObject('changed::show-banners', () => this._sync(), this);
        this._sync();
    }

    _buildMenu() {
        this.menu = new PopupMenu.PopupMenu(this.button, 0.5, St.Side.TOP);
        this.menu.actor.add_style_class_name('notchboard-bell-menu');
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        this._manager = new PopupMenu.PopupMenuManager(this.button);
        this._manager.addMenu(this.menu);
        const panel = new St.BoxLayout({vertical: true, style_class: 'notchboard-bell-panel'});
        const header = new St.BoxLayout({style_class: 'notchboard-bell-header'});
        header.add_child(new St.Label({text: 'Notifications', style_class: 'notchboard-bell-heading',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._clear = this._pill('Clear all', () => this.clearAll());
        header.add_child(this._clear);
        panel.add_child(header);
        this._scroll = new St.ScrollView({style_class: 'notchboard-bell-scroll',
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false});
        this._list = new St.BoxLayout({vertical: true, style_class: 'notchboard-bell-list'});
        this._scroll.set_child(this._list);
        panel.add_child(this._scroll);
        const footer = new St.BoxLayout({style_class: 'notchboard-bell-footer'});
        this._dnd = this._pill('Do Not Disturb', () =>
            this._settings.set_boolean('show-banners', !this._settings.get_boolean('show-banners')));
        footer.add_child(this._dnd);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(this._pill('Settings', () => {
            this.menu.close();
            Util.spawn(['gnome-control-center', 'notifications']);
        }));
        panel.add_child(footer);
        this.menu.box.add_child(panel);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this.button.add_style_pseudo_class('checked');
            } else {
                this.button.remove_style_pseudo_class('checked');
                this._fresh.clear();
            }
            this._desktop._syncIsland();
        });
    }

    _pill(label, action) {
        const button = new St.Button({label, style_class: 'notchboard-bell-pill', can_focus: true});
        button.connect('clicked', action);
        return button;
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notify::count', () => this._sync(),
            'notification-request-banner', (_source, notification) => this._arrived(notification), this);
    }

    _unwatch(source) {
        if (this._sources.delete(source))
            source.disconnectObject(this);
    }

    toggle() {
        if (this.menu.isOpen) {
            this.menu.close();
            return;
        }
        this._render();
        this.menu.open();
    }

    clearAll() {
        for (const source of Main.messageTray.getSources())
            source.destroyNonResidentNotifications();
    }

    _groups() {
        const newest = (a, b) => a.datetime && b.datetime ? b.datetime.difference(a.datetime) : 0;
        return Main.messageTray.getSources()
            .map(source => ({source, items: [...source.notifications].sort(newest)}))
            .filter(group => group.items.length)
            .sort((a, b) => newest(a.items[0], b.items[0]));
    }

    // Opening the list counts as seeing everything in it; rows that were
    // unseen keep their dot until the list closes.
    _render() {
        this._renderId = 0;
        if (this._destroyed)
            return;
        this._list.destroy_all_children();
        const groups = this._groups();
        const unseen = [];
        for (const {source, items} of groups) {
            this._list.add_child(new St.Label({text: source.title ?? '', style_class: 'notchboard-bell-group'}));
            for (const notification of items) {
                if (!notification.acknowledged)
                    unseen.push(notification);
                this._list.add_child(this._row(notification,
                    !notification.acknowledged || this._fresh.has(notification)));
            }
        }
        if (!groups.length) {
            this._list.add_child(new St.Label({text: 'No notifications', style_class: 'notchboard-bell-empty',
                x_align: Clutter.ActorAlign.CENTER}));
        }
        this._clear.visible = groups.some(({items}) => items.some(n => !n.resident));
        for (const notification of unseen) {
            this._fresh.add(notification);
            notification.acknowledged = true;
        }
    }

    _queueRender() {
        if (this._renderId || !this.menu.isOpen)
            return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _row(notification, fresh) {
        const body = plain(notification);
        const row = new St.Button({style_class: 'notchboard-bell-row', can_focus: true, track_hover: true,
            x_expand: true, accessible_name: [notification.title, body].filter(Boolean).join(': ')});
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Widget({style_class: 'notchboard-bell-dot', opacity: fresh ? 255 : 0,
            y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Icon({gicon: notification.gicon ?? notification.source.icon,
            fallback_icon_name: 'dialog-information-symbolic', style_class: 'notchboard-bell-row-icon',
            y_align: Clutter.ActorAlign.START}));
        const text = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'notchboard-bell-text'});
        const head = new St.BoxLayout();
        head.add_child(new St.Label({text: notification.title ?? '', style_class: 'notchboard-bell-title',
            x_expand: true}));
        head.add_child(new St.Label({text: age(notification.datetime), style_class: 'notchboard-bell-time'}));
        text.add_child(head);
        if (body)
            text.add_child(new St.Label({text: body, style_class: 'notchboard-bell-body'}));
        box.add_child(text);
        const close = new St.Button({style_class: 'notchboard-bell-close', can_focus: true,
            accessible_name: 'Dismiss notification', y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 10})});
        close.connect('clicked', () => notification.destroy());
        box.add_child(close);
        row.set_child(box);
        row.connect('clicked', () => {
            this.menu.close();
            notification.activate();
        });
        return row;
    }

    _sync() {
        if (this._destroyed)
            return;
        this.unseen = Main.messageTray.getSources().reduce((sum, source) => sum + source.unseenCount, 0);
        this._badge.text = this.unseen > 9 ? '9+' : String(this.unseen);
        this._badge.visible = this.unseen > 0;
        const muted = !this._settings.get_boolean('show-banners');
        this._icon.gicon = muted ? MUTED : BELL;
        if (this.unseen > 0)
            this.button.add_style_class_name('unseen');
        else
            this.button.remove_style_class_name('unseen');
        if (muted)
            this._dnd.add_style_pseudo_class('checked');
        else
            this._dnd.remove_style_pseudo_class('checked');
        this._queueRender();
    }

    // Mirrors the cases where GNOME would have shown a banner (and played its
    // sound). CRITICAL notifications still get their own banner and sound.
    _arrived(notification) {
        if (this._destroyed || notification.acknowledged ||
            notification.urgency === MessageTray.Urgency.LOW ||
            notification.urgency === MessageTray.Urgency.CRITICAL ||
            !Main.sessionMode.hasNotifications || Main.sessionMode.isLocked ||
            !wouldBanner(notification.source.policy))
            return;
        notification.playSound();
        this.ring();
    }

    ring() {
        const generation = ++this._ringGeneration;
        const duration = this._desktop.owner._duration() ? 70 : 0;
        const icon = this._icon;
        icon.remove_transition('rotation-angle-z');
        const step = index => {
            if (this._destroyed || generation !== this._ringGeneration || index >= RING.length)
                return;
            icon.ease({rotation_angle_z: RING[index], duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD, onComplete: () => step(index + 1)});
        };
        step(0);
        this._desktop.alertIsland();
    }

    destroy() {
        this._destroyed = true;
        releaseBanners();
        if (this._renderId)
            GLib.source_remove(this._renderId);
        this._renderId = 0;
        Main.messageTray.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const source of this._sources)
            source.disconnectObject(this);
        this._sources.clear();
        this._fresh.clear();
        this.menu.destroy();
        this.button.destroy();
    }
}
