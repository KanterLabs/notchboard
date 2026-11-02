import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LIFETIME = 10_000;

// A transient child of the existing notch: shares its visibility and ears,
// never steals focus on arrival and writes the clipboard only on a click.
export class CodePrompt {
    constructor(desktop) {
        this._desktop = desktop;
        this.active = false;
        this._generation = 0;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true, visible: false, x_align: Clutter.ActorAlign.CENTER});
        this._content = new St.BoxLayout({vertical: true, style_class: 'notchboard-code',
            x_expand: true, y_align: Clutter.ActorAlign.START});
        this.actor.add_child(this._content);
        const source = new St.BoxLayout({style_class: 'notchboard-code-source'});
        this._icon = new St.Icon({icon_size: 22, fallback_icon_name: 'mail-unread-symbolic'});
        source.add_child(this._icon);
        const meta = new St.BoxLayout({vertical: true, x_expand: true});
        this._source = new St.Label({style_class: 'notchboard-code-source-name'});
        this._source.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(this._source);
        meta.add_child(new St.Label({text: 'Verification code', style_class: 'notchboard-code-caption'}));
        source.add_child(meta);
        this._content.add_child(source);
        const row = new St.BoxLayout({style_class: 'notchboard-code-row'});
        this._digits = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._digits);
        this._copy = new St.Button({label: 'Copy code', style_class: 'notchboard-code-copy',
            can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._copy.connect('clicked', () => this.copy());
        row.add_child(this._copy);
        this._content.add_child(row);
        const footer = new St.BoxLayout({style_class: 'notchboard-code-footer'});
        this._track = new St.Widget({style_class: 'notchboard-code-track',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_align: Clutter.ActorAlign.CENTER, height: 2});
        this._fill = new St.Widget({style_class: 'notchboard-code-fill', height: 2, x_expand: true});
        this._fill.set_pivot_point(0, 0.5);
        this._track.add_child(this._fill);
        footer.add_child(this._track);
        this._seconds = new St.Label({style_class: 'notchboard-code-caption', y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._seconds);
        this._dismiss = new St.Button({label: 'Dismiss', style_class: 'notchboard-code-dismiss', can_focus: true});
        this._dismiss.connect('clicked', () => this.dismiss());
        footer.add_child(this._dismiss);
        this._content.add_child(footer);
        this.actor.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.dismiss();
            return Clutter.EVENT_STOP;
        });
        this._remaining = 0;
    }

    offer(notification, code) {
        if (this._destroyed || !this._desktop.revealed || Main.sessionMode.isLocked ||
            !Main.sessionMode.hasNotifications || this._desktop._menuOpen())
            return false;
        this._clear();
        const generation = ++this._generation;
        this.active = true;
        this._code = code;
        this._notification = notification;
        notification.connectObject('destroy', () => this.dismiss(),
            'notify::title', () => this.dismiss(), 'notify::body', () => this.dismiss(), this);
        this._remaining = LIFETIME;
        this._copied = false;
        this._copy.label = 'Copy code';
        this._copy.accessible_name = 'Copy verification code';
        this._copy.remove_style_class_name('copied');
        this._copy.reactive = this._copy.can_focus = true;
        this._dismiss.reactive = this._dismiss.can_focus = true;
        this._source.text = notification.title || notification.source.title || 'Notification';
        this._icon.gicon = notification.gicon ?? notification.source.icon;
        this._digits.destroy_all_children();
        this._digits.accessible_name = `Verification code ${code.split('').join(' ')}`;
        const duration = this._desktop.owner._duration() ? 420 : 0;
        for (let i = 0; i < code.length; i++) {
            const digit = new St.Label({text: code[i], style_class: 'notchboard-code-digit',
                opacity: duration ? 0 : 255, translation_y: duration ? 6 : 0});
            if (code.length === 6 && i === 3)
                digit.set_style('padding-left: 8px;');
            this._digits.add_child(digit);
            digit.ease({opacity: 255, translation_y: 0, duration: duration ? 260 : 0,
                delay: duration ? 120 + i * 30 : 0, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        this._desktop._syncIsland();
        const from = this.actor.visible ? this.actor.height : 0;
        this.actor.remove_all_transitions();
        this._content.remove_all_transitions();
        this.actor.show();
        // The compact row keeps its natural width, including a hosted indicator.
        // Animating this child widens only notches narrower than the code panel.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = 350 * scale;
        const [, height] = this._content.get_preferred_height(width);
        this.actor.set({width: Math.min(width, Math.max(0, this._desktop.notch.width - 24 * scale)), height: from});
        this._content.opacity = duration ? 0 : 255;
        this.actor.ease({width, height, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this._content.ease({opacity: 255, duration: duration ? 220 : 0, delay: duration ? 100 : 0});
        this._progress();
        let previous = GLib.get_monotonic_time();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const now = GLib.get_monotonic_time();
            const focus = global.stage.get_key_focus();
            if (!this._desktop.notch.hover && !(focus && this.actor.contains(focus)))
                this._remaining -= (now - previous) / 1000;
            previous = now;
            this._progress();
            if (this._remaining <= 0 || generation !== this._generation) {
                this._timer = 0;
                this.dismiss();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        return true;
    }

    _progress() {
        this._fill.scale_x = Math.max(0, Math.min(1, this._remaining / LIFETIME));
        this._seconds.text = `${Math.max(0, Math.ceil(this._remaining / 1000))}s`;
    }

    copy() {
        if (!this.active || this._copied || !this._code || Main.sessionMode.isLocked)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._code);
        const focus = global.stage.get_key_focus();
        if (focus && this.actor.contains(focus))
            global.stage.set_key_focus(null);
        this._copied = true;
        this._copy.label = '✓ Copied';
        this._copy.accessible_name = 'Code copied';
        this._copy.add_style_class_name('copied');
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
            this._timer = 0;
            this.dismiss();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clear() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._notification?.disconnectObject(this);
        this._notification = null;
        this._code = null;
    }

    dismiss(instant = false) {
        if (!this.active && !this.actor.visible)
            return;
        this._clear();
        this.active = false;
        const generation = ++this._generation;
        const focus = global.stage.get_key_focus();
        if (focus && this.actor.contains(focus))
            global.stage.set_key_focus(null);
        this._copy.reactive = this._copy.can_focus = false;
        this._dismiss.reactive = this._dismiss.can_focus = false;
        this.actor.remove_all_transitions();
        this._content.remove_all_transitions();
        const duration = !instant && this._desktop.owner._duration() ? 300 : 0;
        this._content.ease({opacity: 0, duration: duration ? 160 : 0});
        this.actor.ease({height: 0, width: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (this._destroyed || generation !== this._generation)
                    return;
                this.actor.hide();
                this._digits.destroy_all_children();
                this._digits.accessible_name = '';
                this._source.text = '';
            }});
        this._desktop._syncIsland();
    }

    destroy() {
        this._destroyed = true;
        this.active = false;
        this._generation++;
        this._clear();
        this.actor.destroy();
    }
}
