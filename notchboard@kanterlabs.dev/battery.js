import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

const INTERFACE = `<node><interface name="org.freedesktop.UPower.Device">
  <property name="IsPresent" type="b" access="read"/>
  <property name="Type" type="u" access="read"/>
  <property name="Percentage" type="d" access="read"/>
  <property name="State" type="u" access="read"/>
  <property name="TimeToEmpty" type="x" access="read"/>
  <property name="TimeToFull" type="x" access="read"/>
</interface></node>`;
// UPower device states and the battery device type.
const CHARGING = 1, FULL = 4, PENDING_CHARGE = 5;
const BATTERY = 2;
const LOW = 20;

function duration(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes} min`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// A hairline along the bottom of the island whose length is the laptop's
// charge, coloured like iPhone's battery: white, green on power, red when low.
export class BatteryLine {
    constructor(desktop) {
        this._desktop = desktop;
        this.reading = null;
        this.track = new St.Widget({style_class: 'notchboard-battery', x_expand: true, visible: false,
            accessible_name: 'Battery'});
        this.fill = new St.Widget({style_class: 'notchboard-battery-fill'});
        this.track.add_child(this.fill);
        this.track.connect('notify::width', () => this._layout());
        this.label = new St.Label({style_class: 'notchboard-notch-label', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        const info = Gio.DBusNodeInfo.new_for_xml(INTERFACE).interfaces[0];
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, info,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice', info.name,
            this._cancellable, (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`[Notchboard] battery: ${error.message}`);
                    return;
                }
                this._proxy.connectObject('g-properties-changed', () => this._read(), this);
                this._read();
            });
    }

    _read() {
        const get = name => this._proxy?.get_cached_property(name)?.unpack();
        if (!get('IsPresent') || get('Type') !== BATTERY) {
            this.setReading(null);
            return;
        }
        this.setReading({percentage: get('Percentage') ?? 0, state: get('State') ?? 0,
            timeToEmpty: get('TimeToEmpty') ?? 0, timeToFull: get('TimeToFull') ?? 0});
    }

    setReading(reading) {
        if (this._destroyed)
            return;
        this.reading = reading;
        this.track.visible = this.label.visible = !!reading;
        if (!reading)
            return;
        const percent = Math.round(reading.percentage);
        const powered = [CHARGING, FULL, PENDING_CHARGE].includes(reading.state);
        this.fill.set_style_class_name(`notchboard-battery-fill${powered ? ' charging' : percent <= LOW ? ' low' : ''}`);
        const time = reading.state === CHARGING && reading.timeToFull > 0 ? ` · ${duration(reading.timeToFull)} to full`
            : !powered && reading.timeToEmpty > 0 ? ` · ${duration(reading.timeToEmpty)} left` : '';
        this.label.text = `${powered && reading.state !== CHARGING ? 'Plugged in' : reading.state === CHARGING
            ? 'Charging' : 'Battery'} ${percent}%${time}`;
        this.track.accessible_name = this.label.text;
        this._layout();
    }

    _layout() {
        if (!this.reading || this._destroyed)
            return;
        const fraction = Math.max(0, Math.min(1, this.reading.percentage / 100));
        this.fill.width = Math.round(this.track.width * fraction);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this.track.destroy();
        this.label.destroy();
    }
}
