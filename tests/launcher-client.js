import Gtk from 'gi://Gtk?version=4.0';
const app = new Gtk.Application({application_id: 'dev.kanterlabs.NotchboardLaunch'});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({application: app, title: 'Grid launcher verification',
        default_width: 640, default_height: 420});
    window.set_child(new Gtk.Label({label: 'Opened from the Notchboard launchpad.'}));
    window.present();
});
app.run([]);
