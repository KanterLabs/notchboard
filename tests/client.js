import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
const app = new Gtk.Application({application_id: 'dev.kanterlabs.NotchboardTest'});
app.connect('activate', () => {
    let count = 0;
    const create = () => {
        const window = new Gtk.ApplicationWindow({application: app,
            title: `Grid test ${++count}`, default_width: 640, default_height: 420});
        window.set_child(new Gtk.Label({label: `Window ${count}\n\nNotchboard integration test`}));
        window.present();
        return window;
    };
    create();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        const window = create();
        if (count === 7) {
            const dialog = new Gtk.Window({application: app, transient_for: window, modal: true,
                title: 'Grid test dialog', default_width: 320, default_height: 180});
            dialog.set_child(new Gtk.Label({label: 'This dialog stays with its parent.'}));
            dialog.present();
        }
        return count < 7 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    });
});
app.run([]);
