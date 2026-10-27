import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

export default class GridTest extends Extension {
    enable() {
        if (this._started)
            return;
        this._started = true;
        if (!GLib.getenv('NOTCHBOARD_TEST_DIR'))
            throw new Error('Test extension may only run in an isolated compositor');
        // Use a real PanelMenu actor with synthetic readings: no credentials
        // or provider network requests are used in the isolated compositor.
        this._keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._fakeAI = new PanelMenu.Button(0.5, 'AI Usage fixture');
        this._fakeAiLabel = new St.Label({text: 'Claude 82%   Codex 64%', y_align: Clutter.ActorAlign.CENTER});
        this._fakeAI.add_child(this._fakeAiLabel);
        this._fakeAiMenuActions = 0;
        this._fakeAiItem = new PopupMenu.PopupMenuItem('AI usage details (test fixture)');
        this._fakeAiItem.connect('activate', () => this._fakeAiMenuActions++);
        this._fakeAI.menu.addMenuItem(this._fakeAiItem);
        Main.panel.addToStatusArea('ai-usage@laptopconfig', this._fakeAI);
        this._run().catch(error => this._report({passed: false, error: String(error), stack: error.stack}));
    }
    disable() {}
    _report(result) {
        const file = Gio.File.new_for_path(`${GLib.getenv('NOTCHBOARD_TEST_DIR')}/result.json`);
        file.replace_contents(JSON.stringify(result, null, 2), null, false,
            Gio.FileCreateFlags.NONE, null);
        console.log(`NOTCHBOARD_TEST ${JSON.stringify(result)}`);
    }
    async _run() {
        const checks = [];
        const wmBindings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
        const [, initialBytes] = Gio.File.new_for_path(
            `${GLib.getenv('NOTCHBOARD_TEST_DIR')}/bindings-before.json`).load_contents(null);
        const initialBindings = JSON.parse(new TextDecoder().decode(initialBytes));
        const check = (value, message) => {
            if (!value)
                throw new Error(message);
            checks.push(message);
        };
        await wait(2500);
        Main.overview.hide();
        await wait(500);
        const extension = Main.extensionManager.lookup('notchboard@kanterlabs.dev');
        check(extension?.state === 1, `Extension ACTIVE: state=${extension?.state}, error=${extension?.error}`);
        const grid = extension.stateObj._runtime;
        const journal = JSON.parse(grid._settings.get_string('restore-state'));
        check(grid._bindings.length === 11, 'All eleven shortcuts registered');
        check(global.workspace_manager.layout_columns === 3, 'Native layout has three columns');
        const desktop = grid._desktop;
        check(desktop.notch.visible, 'Workspace notch is visible');
        check(grid._overlayCompositing, 'Visible notch inhibits bypassing Shell composition');
        check(!Main.layoutManager.panelBox.visible, 'Full-width top bar is hidden');
        check(desktop.notch.y === Main.layoutManager.primaryMonitor.y, 'Island hangs from the top screen edge');
        {
            const [left, right] = desktop._ears.ears;
            check(left.visible && right.visible && left.y === desktop.notch.y && right.y === desktop.notch.y &&
                left.x + left.width === desktop.notch.x && right.x === desktop.notch.x + desktop.notch.width,
            `Ears curve the island into the top edge: ${left.x},${left.y} ${right.x} notch ${desktop.notch.x}+${desktop.notch.width}`);
        }
        check(desktop.notch.get_theme_node().get_background_color().to_string() === '#000000ff',
            'Island is a pure black pill');
        const clockX = () => desktop._clockLabel.get_transformed_position()[0];
        await wait(1800);
        check(!desktop.expanded && !desktop._drawer.visible, 'Island starts compact with its drawer closed');
        const compactX = clockX(), compactHeight = desktop.notch.height;
        desktop._pulseIsland();
        await wait(500);
        check(desktop.expanded && desktop._drawer.visible && desktop.notch.height > compactHeight,
            'Island opens a drawer beneath the compact row');
        check(Math.abs(clockX() - compactX) <= 1, 'Compact row stays put while the island expands');
        await wait(1800);
        check(!desktop.expanded && !desktop._drawer.visible && desktop.notch.height === compactHeight,
            'Island collapses back to a pill after a workspace pulse');
        check(/\d+:\d\d/.test(desktop._clockLabel.text), 'Notch displays the current time');
        check(desktop.notch.contains(this._fakeAI.container), 'Original AI indicator is hosted inside the notch');
        this._fakeAiLabel.text = 'Claude 81%   Codex 63%';
        check(desktop._ai.indicator.get_first_child().text.includes('81%'),
            'AI readings update through the original live actor');
        // A stray virtual-pointer motion can reach the top-left hot corner and
        // open the Overview; the isolated session has no use for hot corners.
        new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
        const pointer = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const pointerEvents = [];
        const pointerTrace = global.stage.connect('captured-event', (_stage, event) => {
            if ([Clutter.EventType.BUTTON_PRESS, Clutter.EventType.BUTTON_RELEASE].includes(event.type()))
                pointerEvents.push(`${event.type()}:${event.get_button()}:${event.get_source()?.constructor.name}`);
            return Clutter.EVENT_PROPAGATE;
        });
        this._fakeAI.menu.connect('open-state-changed', (_menu, open) => console.log(`GRID_AI_MENU ${open}`));
        const clickActor = async actor => {
            await wait(120);
            const [x, y] = actor.get_transformed_position();
            console.log(`GRID_CLICK ${actor.constructor.name} ${x},${y} ${actor.width}x${actor.height}`);
            // The first virtual-pointer motion can land on one axis only, so
            // repeat it until the pointer reports the requested position.
            const [targetX, targetY] = [x + actor.width / 2, y + actor.height / 2];
            for (let attempt = 0; attempt < 5; attempt++) {
                pointer.notify_absolute_motion(GLib.get_monotonic_time(), targetX, targetY);
                await wait(80);
                const [px, py] = global.get_pointer();
                if (Math.abs(px - targetX) <= 1 && Math.abs(py - targetY) <= 1)
                    break;
            }
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await wait(40);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await wait(180);
        };
        await clickActor(this._fakeAI);
        await wait(180);
        check(!desktop.expanded, 'Open AI menu keeps the island drawer closed');
        check(this._fakeAI.menu.isOpen && !Main.layoutManager.panelBox.visible,
            `Clicking AI usage opens its menu without revealing the full top bar: menu=${this._fakeAI.menu.isOpen}, panel=${Main.layoutManager.panelBox.visible}, pointer=${global.get_pointer()}, events=${pointerEvents}`);
        await clickActor(this._fakeAiItem);
        check(this._fakeAiMenuActions === 1 && !this._fakeAI.menu.isOpen,
            'AI menu remains interactive after moving into the notch');
        global.stage.disconnect(pointerTrace);
        const clockSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const clockFormat = clockSettings.get_string('clock-format');
        clockSettings.set_string('clock-format', '12h');
        await wait(100);
        check(/AM|PM/.test(desktop._clockLabel.text), 'Notch clock follows the live clock-format setting');
        clockSettings.set_string('clock-format', clockFormat);
        await wait(100);
        check(desktop.launcher?.visible, `Empty workspace shows centered launchpad: launcher=${!!desktop.launcher} overview=${Main.overview.visible} active=${global.workspace_manager.get_active_workspace_index()} occupied=${[...grid._occupied()]} windows=${global.workspace_manager.get_active_workspace().list_windows().map(w => `${w.get_title()}:${w.get_window_type()}`)} locked=${Main.sessionMode.isLocked}`);
        check(desktop.launcher.opacity === 255, 'Interactive launcher is fully opaque on appearance');
        check(Main.uiGroup.get_children().indexOf(desktop.launcher) >
            Main.uiGroup.get_children().indexOf(global.window_group),
        'Launchpad paints above GNOME wallpaper');
        check(!Main.overview.dash.visible, 'Bottom app bar is hidden');
        check([...desktop._docks.keys()].every(actor => !actor.visible),
            'Every dock actor stays hidden');
        check(desktop.apps.length > 0 && desktop.results.length > 0, 'Launchpad displays installed apps');
        desktop.search.set_text('Grid Launch Verification');
        check(desktop.results.length === 1, 'Search finds an installed app');
        desktop.search.set_text('no-such-application-12345');
        check(desktop.results.length === 0, 'No-match search has an empty state');
        desktop.search.set_text('');
        const shooter = new (await import('gi://Shell')).default.Screenshot();
        const capture = async name => {
            const stream = Gio.File.new_for_path(`${GLib.getenv('NOTCHBOARD_TEST_DIR')}/${name}.png`)
                .replace(null, false, Gio.FileCreateFlags.NONE, null);
            await shooter.screenshot(false, stream);
            stream.close(null);
        };
        await wait(200);
        await capture('launchpad');
        const bell = desktop.bell;
        const rowsOf = () => bell._list.get_children().filter(actor => actor.has_style_class_name('notchboard-bell-row'));
        // Start from a known state: CI sessions begin with a system notification
        // (no display manager), so emulate one here and dismiss it like a user.
        Main.notify('Pre-existing notification', 'Present before the test started');
        await wait(100);
        for (const source of Main.messageTray.getSources())
            [...source.notifications].forEach(notification => notification.destroy());
        await wait(200);
        check(desktop.notch.contains(bell.button) && !bell._badge.visible &&
            bell._icon.gicon.get_file().query_exists(null),
        `Island shows a quiet bundled bell when nothing is missed: badge=${bell._badge.visible}/${bell._badge.text} icon=${bell._icon.gicon?.get_file?.()?.get_path()}`);
        const notifySource = new MessageTray.Source({title: 'Grid Notifications', iconName: 'dialog-information-symbolic'});
        Main.messageTray.add(notifySource);
        let activations = 0;
        const first = new MessageTray.Notification({source: notifySource, title: 'First ping',
            body: 'Hello <b>there</b> &amp; welcome', useBodyMarkup: true});
        first.connect('activated', () => activations++);
        const ringsBefore = bell._ringGeneration;
        notifySource.addNotification(first);
        await wait(60);
        check(Main.messageTray.queueCount === 0 && !Main.messageTray._notification,
            'Notifications no longer pop up as banners');
        check(bell._ringGeneration === ringsBefore + 1 && desktop.notch.has_style_class_name('alert'),
            'An arrival rings the bell and glows the island');
        check(bell._badge.visible && bell._badge.text === '1', 'Bell badge counts the missed notification');
        const [iconX] = bell._icon.get_transformed_position();
        const [badgeX] = bell._badge.get_transformed_position();
        check(badgeX >= iconX + bell._icon.width && bell.button.contains(bell._badge) &&
            badgeX + bell._badge.width <= desktop.notch.get_transformed_position()[0] + desktop.notch.width,
        'Badge sits beside the bell inside the island without covering it');
        await wait(20);
        const second = new MessageTray.Notification({source: notifySource, title: 'Second ping', body: 'Again'});
        notifySource.addNotification(second);
        await wait(60);
        check(bell._badge.text === '2', `Badge tracks every missed notification: ${bell._badge.text}`);
        await capture('bell-badge');
        await wait(1000);
        check(!desktop.notch.has_style_class_name('alert'), 'Island arrival glow fades out');
        await clickActor(bell.button);
        await wait(300);
        check(bell.menu.isOpen && !desktop.expanded,
            'Clicking the bell drops down the notification list with the drawer closed');
        let rows = rowsOf();
        check(rows.length === 2 && rows[0].accessible_name === 'Second ping: Again' &&
            rows[1].accessible_name === 'First ping: Hello there & welcome',
        `List shows plain-text notifications newest first: ${rows.map(row => row.accessible_name)}`);
        check(bell.unseen === 0 && !bell._badge.visible, 'Opening the list marks everything seen');
        await capture('bell-menu');
        const crowd = new MessageTray.Source({title: 'Grid Crowd'});
        Main.messageTray.add(crowd);
        for (let i = 0; i < 9; i++)
            crowd.addNotification(new MessageTray.Notification({source: crowd, title: `Crowd ${i}`, body: 'Filler'}));
        await wait(400);
        const bar = bell._scroll.get_children().find(child => child instanceof St.ScrollBar && child.height > child.width);
        const [barX] = bar.get_transformed_position();
        const rowRight = Math.max(...rowsOf().map(row => row.get_transformed_position()[0] + row.width));
        check(bar?.visible && bell._scroll.vscrollbar_visible && barX >= rowRight, `Notification scrollbar has its own lane beside the rows: bar=${barX} rows=${rowRight}`);
        await capture('bell-scroll');
        crowd.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        await wait(300);
        await clickActor(rowsOf().find(row => row.accessible_name.startsWith('First ping')));
        await wait(300);
        check(activations === 1 && !bell.menu.isOpen && !notifySource.notifications.includes(first),
            'Clicking a notification activates it and closes the list');
        await clickActor(bell.button);
        await wait(300);
        await clickActor(rowsOf()[0].get_child().get_last_child());
        await wait(300);
        check(!Main.messageTray.getSources().includes(notifySource) && bell.menu.isOpen &&
            bell._list.get_children().some(actor => actor.text === 'No notifications'),
        'Dismissing the last notification leaves an empty list open');
        bell.menu.close();
        await wait(200);
        const notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        notificationSettings.set_boolean('show-banners', false);
        await wait(60);
        const quietSource = new MessageTray.Source({title: 'Grid Quiet'});
        Main.messageTray.add(quietSource);
        const ringsQuiet = bell._ringGeneration;
        quietSource.addNotification(new MessageTray.Notification({source: quietSource, title: 'Quiet one'}));
        quietSource.addNotification(new MessageTray.Notification({source: quietSource, title: 'Kept',
            resident: true}));
        await wait(60);
        check(bell._icon.gicon.get_file().get_basename() === 'notchboard-bell-muted-symbolic.svg' &&
            bell._ringGeneration === ringsQuiet &&
            bell._badge.text === '2', 'Do Not Disturb mutes the bell but still counts notifications');
        notificationSettings.reset('show-banners');
        await clickActor(bell.button);
        await wait(300);
        await clickActor(bell._clear);
        await wait(300);
        check(quietSource.notifications.length === 1 && quietSource.notifications[0].title === 'Kept' &&
            rowsOf().length === 1, 'Clear all keeps resident notifications');
        bell.menu.close();
        quietSource.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        await wait(200);
        const alertSource = new MessageTray.Source({title: 'Grid Critical'});
        Main.messageTray.add(alertSource);
        const critical = new MessageTray.Notification({source: alertSource, title: 'Battery low',
            urgency: MessageTray.Urgency.CRITICAL});
        const ringsCritical = bell._ringGeneration;
        alertSource.addNotification(critical);
        await wait(60);
        check((Main.messageTray._notification === critical || Main.messageTray._notificationQueue.includes(critical)) &&
            bell._ringGeneration === ringsCritical, 'Critical alerts still pop up as banners');
        alertSource.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        await wait(600);
        const center = Main.layoutManager.primaryMonitor;
        const movePointer = async (x, y) => {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
            await wait(80);
        };
        check(!grid._settings.get_boolean('notch-hidden') && desktop.revealed && !desktop._edge.visible,
            'Island is shown at all times by default');
        await movePointer(center.x + center.width / 2, center.y + center.height / 2);
        desktop.toggleNotch();
        await wait(500);
        check(grid._settings.get_boolean('notch-hidden') && !desktop.notch.visible && desktop._edge.visible,
            'Hide toggle slides the island away');
        await movePointer(center.x + center.width / 2, center.y);
        await wait(400);
        check(desktop.notch.visible && desktop.revealed, 'Touching the top edge brings the hidden island back');
        const [notchX, notchY] = desktop.notch.get_transformed_position();
        await movePointer(notchX + desktop.notch.width / 2, notchY + 12);
        await wait(700);
        check(desktop.notch.visible && desktop.revealed, 'A revealed island stays while the pointer is on it');
        await movePointer(center.x + center.width / 2, center.y + center.height / 2);
        await wait(900);
        check(!desktop.notch.visible && !desktop.revealed, 'The island hides again once the pointer leaves');
        desktop.toggleNotch();
        await wait(500);
        check(!grid._settings.get_boolean('notch-hidden') && desktop.notch.visible && !desktop._edge.visible &&
            desktop.notch.translation_y === 0, 'Toggling again keeps the island shown');
        const power = desktop.power;
        const [powerX, powerY] = power.notch.get_transformed_position();
        check(power.notch.visible && power.revealed && !power._edge.visible &&
            powerX === center.x && Math.abs(powerY + power.notch.height - (center.y + center.height)) <= 1 &&
            power.notch.get_theme_node().get_background_color().to_string() === '#000000ff',
        `Power island fills the bottom-left corner: ${powerX},${powerY} ${power.notch.height}`);
        {
            const [up, side] = power._ears.ears;
            check(up.visible && side.visible && up.x === power.notch.x && up.y + up.height === power.notch.y &&
                side.x === power.notch.x + power.notch.width && side.y + side.height === power.notch.y + power.notch.height,
            'Ears curve the power island into the left and bottom edges');
        }
        desktop.toggleNotch();
        await wait(500);
        check(!power.notch.visible && !power.revealed && power._edge.visible &&
            [...power._ears.ears, ...desktop._ears.ears].every(ear => !ear.visible),
        'Hiding the island also slides the power island and both islands’ ears away');
        await movePointer(center.x + 20, center.y + center.height - 1);
        await wait(400);
        check(power.notch.visible && power.revealed && !desktop.revealed,
            'Touching the bottom-left edge brings back only the power island');
        await movePointer(center.x + center.width / 2, center.y + center.height / 2);
        await wait(900);
        check(!power.notch.visible && !power.revealed, 'The power island hides again once the pointer leaves');
        // Answer gnome-session's end-session request without signalling anything.
        const endSession = Main.endSessionDialog;
        const sessionSignals = [];
        endSession._getUpdateInfo = async () => ({});
        const realEmit = endSession._dbusImpl.emit_signal;
        endSession._dbusImpl.emit_signal = name => sessionSignals.push(name);
        let answered = 0;
        const invocation = {return_value: () => answered++};
        await endSession.OpenAsync([2, 0, 60, []], invocation);
        await wait(400);
        check(answered === 1 && power.confirming?.signal === 'ConfirmedReboot' && power.menu.isOpen &&
            power.notch.visible && power._confirm.visible && !endSession.visible,
        'A restart request reveals the hidden power island with its confirmation instead of GNOME’s dialog');
        power.menu.close();
        await wait(900);
        check(sessionSignals.join() === 'Canceled,Closed' && !power.confirming && !power.notch.visible,
            'Dismissing the confirmation cancels the restart and the island hides again');
        desktop.toggleNotch();
        await wait(500);
        check(power.notch.visible && power.revealed && power.notch.translation_y === 0,
            'Showing the island again brings the power island back');
        await clickActor(power.button);
        await wait(300);
        check(power.menu.isOpen && power._panel.visible && !power._confirm.visible &&
            power._tiles.power.visible === power._actions.can_power_off, 'Clicking the power island opens sound and power');
        await capture('power-menu');
        power.menu.close();
        await wait(250);
        sessionSignals.length = 0;
        await endSession.OpenAsync([1, 0, 60, []], invocation);
        await wait(1300);
        check(power.confirming?.signal === 'ConfirmedShutdown' && power._go.label === 'Shut Down' &&
            power._go.has_style_class_name('shutdown') && power._count.text === '59' &&
            power._confirmBody.text === 'Shutting down automatically in 59 s.',
        `Shut down counts down in the island: ${power._count.text} ${power._confirmBody.text}`);
        await capture('power-confirm');
        await clickActor(power._cancel);
        await wait(300);
        check(sessionSignals.join() === 'Canceled,Closed' && !power.confirming && !power.menu.isOpen,
            'Cancel answers gnome-session and folds the confirmation away');
        sessionSignals.length = 0;
        await endSession.OpenAsync([0, 0, 1, []], invocation);
        await wait(1500);
        check(sessionSignals.join() === 'ConfirmedLogout' && !power.confirming && !power.menu.isOpen,
            'An unanswered confirmation goes ahead when its countdown ends');
        endSession._dbusImpl.emit_signal = realEmit;
        delete endSession._getUpdateInfo;
        const osd = Main.osdWindowManager._osdWindows[0];
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: 'audio-volume-medium-symbolic'}), null, 0.4, 1);
        await wait(400);
        check(power._level.visible && !power._compact.visible && !osd.visible,
            'Volume keys stretch the power island instead of showing GNOME’s OSD');
        await wait(1800);
        check(!power._level.visible && power._compact.visible, 'The volume peek settles back into the pill');
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: 'display-brightness-symbolic'}), null, 0.4, 1);
        await wait(200);
        check(osd.visible && !power._level.visible, 'Other OSDs stay GNOME’s own');
        const pillWidth = power.notch.width;
        check(!power._nowPlaying.visible && !power._mediaCard.visible,
            'With nothing playing the pill shows only the power icon, no volume');
        const realMedia = power._media;
        let plays = 0;
        const track = {status: 'Playing', trackTitle: 'Test Song', trackArtists: ['Test Artist'], trackCoverUrl: '',
            app: null, canGoNext: true, canGoPrevious: false, playPause: () => plays++, next() {}, previous() {}};
        power._media = {players: [track]};
        power._syncMedia();
        await wait(400);
        check(power._nowPlaying.visible && power._nowPlayingLabel.text === 'Test Song · Test Artist' &&
            power.notch.width > pillWidth, 'A playing track appears in the pill');
        await clickActor(power.button);
        await wait(300);
        check(power._mediaCard.visible && power._mediaTitle.text === 'Test Song' &&
            power._mediaPlay.child.icon_name === 'media-playback-pause-symbolic' && !power._mediaPrev.reactive,
        'The expanded island shows the track with playback controls');
        await capture('power-media');
        await clickActor(power._mediaPlay);
        check(plays === 1, 'Play/pause reaches the player');
        power.menu.close();
        track.status = 'Paused';
        power._syncMedia();
        await wait(400);
        check(!power._nowPlaying.visible && power._mediaCard.visible && Math.abs(power.notch.width - pillWidth) <= 1,
            'Pausing folds the track out of the pill but keeps it in the expanded island');
        power._media = realMedia;
        power._syncMedia();
        Main.osdWindowManager.hideAll();
        const battery = desktop.battery;
        battery.setReading({percentage: 50, state: 2, timeToEmpty: 5400, timeToFull: 0});
        await wait(150);
        const [, trackY] = battery.track.get_transformed_position();
        const [, islandY] = power.notch.get_transformed_position();
        check(battery.track.visible && power.notch.get_last_child() === battery.track &&
            !desktop.notch.contains(battery.track) && power.menu.actor.contains(battery.label) &&
            Math.abs(battery.fill.width - battery.track.width / 2) <= 1 &&
            battery.track.width >= power.notch.width - 40 &&
            trackY + battery.track.height <= islandY + power.notch.height &&
            battery.label.text === 'Battery 50% · 1 h 30 min left',
        `Battery line spans only the lower island at its charge: ${battery.fill.width}/${battery.track.width}/${power.notch.width} ${battery.label.text}`);
        await capture('battery-line');
        battery.setReading({percentage: 15, state: 2, timeToEmpty: 1200, timeToFull: 0});
        await wait(100);
        check(battery.fill.has_style_class_name('low') && Math.abs(battery.fill.width - battery.track.width * 0.15) <= 1,
            `Battery line turns red when low: ${battery.fill.get_style_class_name()} ${battery.fill.width}/${battery.track.width}`);
        battery.setReading({percentage: 60, state: 1, timeToEmpty: 0, timeToFull: 1800});
        await wait(100);
        check(battery.fill.has_style_class_name('charging') && battery.label.text === 'Charging 60% · 30 min to full',
            'Battery line turns green while charging');
        battery.setReading(null);
        check(!battery.track.visible && !battery.label.visible, 'No battery line without a laptop battery');
        battery._read();
        const pods = desktop.airpods;
        check(!pods.button.visible && !pods.connected, 'AirPods stay out of the island while EarPort is absent');
        let scans = 0, scanModel = null;
        // Never scan the real Bluetooth adapter from the isolated session.
        pods._scanner = {scan: async model => {
            scans++;
            scanModel = model;
            return {model, left: 70, right: 60, case: -1, chargingLeft: false, chargingRight: false,
                chargingCase: false, rssi: -60};
        }};
        const podTypes = {Connected: 'b', DeviceName: 's', DisplayName: 's', DeviceModel: 's', IsHeadphones: 'b',
            SupportsANC: 'b', SupportsAdaptive: 'b', BatteryLeft: 'i', BatteryRight: 'i', BatteryCase: 'i',
            ChargingLeft: 'b', ChargingRight: 'b', ChargingCase: 'b', NoiseControlMode: 's',
            ConversationalAwareness: 'b', LeftInEar: 'b', RightInEar: 'b'};
        const podState = {Connected: true, DeviceName: 'Test AirPods', DisplayName: '',
            DeviceModel: 'AirPods 4th Gen (ANC)', IsHeadphones: false, SupportsANC: true, SupportsAdaptive: true,
            BatteryLeft: -1, BatteryRight: -1, BatteryCase: -1, ChargingLeft: false, ChargingRight: false,
            ChargingCase: false, NoiseControlMode: 'anc', ConversationalAwareness: false,
            LeftInEar: false, RightInEar: false};
        const modeCalls = [];
        const podImpl = {
            SetNoiseControlMode: mode => {
                modeCalls.push(mode);
                setPod('NoiseControlMode', mode);
            },
            SetConversationalAwareness: enabled => setPod('ConversationalAwareness', enabled),
        };
        for (const key of Object.keys(podTypes))
            Object.defineProperty(podImpl, key, {get: () => podState[key]});
        const podXml = `<node><interface name="io.github.anoryth.EarPort1">${
            Object.entries(podTypes).map(([key, type]) => `<property name="${key}" type="${type}" access="read"/>`).join('')
        }<method name="SetNoiseControlMode"><arg type="s" name="mode" direction="in"/></method>
        <method name="SetConversationalAwareness"><arg type="b" name="enabled" direction="in"/></method>
        </interface></node>`;
        const exportedPods = Gio.DBusExportedObject.wrapJSObject(podXml, podImpl);
        const setPod = (key, value) => {
            podState[key] = value;
            exportedPods.emit_property_changed(key, new GLib.Variant(podTypes[key], value));
            exportedPods.flush();
        };
        exportedPods.export(Gio.DBus.session, '/io/github/anoryth/EarPort');
        const podOwner = Gio.bus_own_name_on_connection(Gio.DBus.session, 'io.github.anoryth.EarPort',
            Gio.BusNameOwnerFlags.NONE, null, null);
        await wait(700);
        check(pods.button.visible && pods.connected && power.notch.contains(pods.button) &&
            !desktop.notch.contains(pods.button),
            'AirPods appear only in the lower island when EarPort reports a connection');
        check(scans === 1 && scanModel === 0x1B20 && pods._label.text === '60%' && pods._source.visible,
            `Missing EarPort battery falls back to the AirPods broadcast: ${scans} ${scanModel} ${pods._label.text}`);
        const chrome = pods._peek.get_parent().get_children();
        const [peekX, peekY] = pods._peek.get_transformed_position();
        check(pods._peek.visible && pods._peek.get_parent() === power.notch.get_parent() &&
            chrome.indexOf(pods._peek) > chrome.indexOf(power.notch) && peekX === center.x + 6 &&
            peekY > center.y + center.height / 2,
            'Connecting shows the AirPods card over the lower island');
        await wait(400);
        await capture('airpods-peek');
        await wait(3400);
        check(!pods._peek.visible, 'The connect card goes away after a few seconds');
        setPod('BatteryLeft', 15);
        setPod('BatteryRight', 40);
        setPod('LeftInEar', true);
        await wait(250);
        check(pods._label.text === '15%' && pods._label.has_style_class_name('low') && !pods._source.visible,
            `Exact EarPort battery wins and low battery turns red: ${pods._label.text}`);
        setPod('BatteryLeft', 82);
        setPod('BatteryRight', 79);
        setPod('BatteryCase', 54);
        setPod('ChargingCase', true);
        setPod('RightInEar', true);
        await wait(250);
        check(pods._label.text === '79%' && !pods._label.has_style_class_name('low'),
            'Island shows the lowest bud in use');
        await clickActor(pods.button);
        await wait(300);
        check(pods.menu.isOpen && !desktop.expanded && pods._cells.left.value.text === '82' &&
            pods._cells.case.caption.text === 'Case ⚡' && pods._status.text === 'Connected · both in ear',
        'Clicking the AirPods opens battery details for each part');
        await capture('airpods-menu');
        await clickActor(pods._modeButtons.transparency);
        await wait(300);
        check(modeCalls.at(-1) === 'transparency' && pods._modeButtons.transparency.has_style_pseudo_class('checked') &&
            !pods._modeButtons.anc.has_style_pseudo_class('checked'), 'Noise control buttons change the AirPods mode');
        await clickActor(pods._awareness);
        await wait(300);
        check(podState.ConversationalAwareness && pods._switch.state, 'Conversation Awareness toggles from the island');
        pods.menu.close();
        await wait(200);
        setPod('Connected', false);
        await wait(250);
        check(!pods.button.visible && !pods.connected, 'AirPods leave the island when disconnected');
        Gio.bus_unown_name(podOwner);
        exportedPods.unexport();
        await wait(200);
        const client = Gio.Subprocess.new(['gjs', '-m', GLib.getenv('NOTCHBOARD_TEST_CLIENT')],
            Gio.SubprocessFlags.NONE);
        await wait(5000);
        const windows = [...grid._windows.keys()];
        check(windows.length === 7, `Seven real GTK windows assigned: ${windows.length}`);
        const dialog = global.get_window_actors().map(a => a.meta_window)
            .find(w => w.get_title() === 'Grid test dialog');
        check(dialog?.get_transient_for() && !grid._windows.has(dialog) &&
            dialog.get_workspace() === dialog.get_transient_for().get_workspace(),
        'Real dialog remains on its parent workspace without consuming a cell');
        dialog.delete(global.get_current_time());
        await wait(250);
        const cells = windows.map(w => w.get_workspace().index());
        check(new Set(cells).size === 7, `One window per workspace: ${cells}`);
        check(windows.every(w => w.get_maximize_flags() === Meta.MaximizeFlags.BOTH), 'All windows maximized');
        const monitor = Main.layoutManager.primaryMonitor;
        const workarea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor.index);
        check(workarea.y + workarea.height === monitor.y + monitor.height,
            'Hidden fixed dock releases the bottom screen area');
        check(workarea.y === monitor.y, 'Replacement notch releases the old top-bar screen area');
        check(!desktop.launcher.visible, 'Launchpad hides behind occupied workspaces');
        check(global.workspace_manager.n_workspaces >= 9, 'Grid grew beyond initial two rows');
        const wm = global.workspace_manager;
        wm.get_workspace_by_index(0).activate(global.get_current_time());
        await wait(220);
        // Unseen notifications colour their window's cell in the island map
        // until that window is focused. Shaped like GNOME's attention notice.
        const pinged = windows.find(w => w.get_workspace().index() === 2);
        const pingSource = new MessageTray.Source({title: 'Grid Ping'});
        pingSource._window = pinged;
        Main.messageTray.add(pingSource);
        pingSource.addNotification(new MessageTray.Notification({source: pingSource, title: 'Ping'}));
        await wait(150);
        const notifiedDots = () => desktop._mini.get_children().filter(dot => dot.has_style_class_name('notified'));
        check(bell.notifiedCells().size === 1 && bell.notifiedCells().has(2) && notifiedDots().length === 1,
            `A window with unseen notifications lights its island cell: cells=${[...bell.notifiedCells()]} dots=${notifiedDots().length}`);
        wm.get_workspace_by_index(2).activate_with_focus(pinged, global.get_current_time());
        await wait(250);
        check(pingSource.unseenCount === 0 && notifiedDots().length === 0,
            `Focusing the window marks its notifications seen: unseen=${pingSource.unseenCount} dots=${notifiedDots().length}`);
        pingSource.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        wm.get_workspace_by_index(0).activate(global.get_current_time());
        await wait(220);
        grid._navigate('right');
        await wait(220);
        check(wm.get_active_workspace_index() === 1, 'Right arrow selects adjacent column');
        grid._navigate('down');
        await wait(220);
        check(wm.get_active_workspace_index() === 4, 'Down arrow selects next row');
        // Rapid interruptions must settle every Mutter switch callback.
        grid._navigate('left');
        await wait(25);
        grid._navigate('up');
        await wait(25);
        grid._navigate('right');
        await wait(250);
        check(wm.get_active_workspace_index() === 1 && !grid._slide, 'Rapid direction changes finish without a queued slide');
        grid._navigate('left', true);
        await wait(220);
        check(wm.get_active_workspace_index() === 1, 'Moving into an occupied neighbor is blocked');
        // Test real window close and hole reuse without compacting other cells.
        const closed = windows.find(w => w.get_workspace().index() === 0);
        const survivor = windows.find(w => w.get_workspace().index() === 2);
        closed.delete(global.get_current_time());
        await wait(300);
        check(survivor.get_workspace().index() === 2, 'Closing a window preserves other positions');
        grid._navigate('left', true);
        await wait(220);
        check(wm.get_active_workspace_index() === 0,
            `Focused window moves into empty neighbor: active=${wm.get_active_workspace_index()}, focus=${global.display.focus_window?.get_title()}, cells=${[...grid._windows.keys()].map(w => `${w.get_title()}@${w.get_workspace().index()}`)}`);
        // Map should hold its actors, show clones and fade cleanly without Super.
        grid._showMap();
        await wait(120);
        check(grid._map?.visible && grid._selection, 'Live map and selection are visible');
        const clones = [];
        const visit = actor => {
            if (actor.constructor.name.includes('Clone')) clones.push(actor);
            for (const child of actor.get_children()) visit(child);
        };
        visit(grid._map);
        check(clones.length > 0, `Map contains live thumbnails: ${clones.length}`);
        const keyboard = this._keyboard;
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
        await wait(80);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Right, Clutter.KeyState.PRESSED);
        await wait(100);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Right, Clutter.KeyState.RELEASED);
        await wait(300);
        check(wm.get_active_workspace_index() === 1, 'Real Super + Right keybinding navigates');
        check(grid._map?.visible, 'Holding Super keeps the map visible');
        // Capture map pixels for manual QA without exposing the live desktop.
        const screenshot = new (await import('gi://Shell')).default.Screenshot();
        const path = `${GLib.getenv('NOTCHBOARD_TEST_DIR')}/map.png`;
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        await screenshot.screenshot(false, stream);
        stream.close(null);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
        await wait(450);
        check(!grid._map, 'Map fades after modifier release');
        const tapSuper = async (expectedOnPress = null, key = Clutter.KEY_Super_L) => {
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            await wait(120);
            if (expectedOnPress !== null)
                check(!!grid._map === expectedOnPress,
                    expectedOnPress ? 'Super shows the grid on key-down before release or an arrow' :
                        'Super closes the grid on key-down before release');
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            await wait(300);
        };
        await tapSuper(true);
        check(grid._map?.visible && grid._mapPinned && !Main.overview.visible,
            'Standalone Super opens the grid instead of GNOME Overview');
        await wait(650);
        check(grid._map?.visible && grid._mapPinned, 'Super-toggled grid stays open after key release');
        check(grid._map.opacity === 255 && grid._map.get_paint_opacity() === 255,
            'Interactive grid is fully painted rather than transparent');
        const fullscreenWindow = [...grid._windows.keys()][0];
        const fullscreenWorkspace = fullscreenWindow.get_workspace();
        fullscreenWorkspace.activate_with_focus(fullscreenWindow, global.get_current_time());
        await wait(250);
        check(!desktop.launcher.visible, 'Occupied workspace hides the launcher before fullscreen');
        let fullscreenLauncherShows = 0;
        const launcherVisibilityId = desktop.launcher.connect('notify::visible', () => {
            if (desktop.launcher.visible)
                fullscreenLauncherShows++;
        });
        fullscreenWindow.make_fullscreen();
        await wait(500);
        check(fullscreenWindow.is_fullscreen() && Main.layoutManager.primaryMonitor.inFullscreen,
            'Real application enters fullscreen on the active monitor');
        check(desktop.notch.visible && desktop.notch.is_mapped() && grid._map?.visible && grid._map.is_mapped(),
            'Notch and pinned grid remain mapped over fullscreen apps');
        const abovePopups = actor => Main.uiGroup.get_children().indexOf(actor) >
            Main.uiGroup.get_children().indexOf(global.top_window_group);
        check(abovePopups(desktop.notch) && abovePopups(grid._map),
            'Notch and map paint above application windows and popups');
        await capture('fullscreen-grid');
        await tapSuper(false);
        check(!grid._map && !grid._mapPinned, 'Super closes the grid while a fullscreen app has keyboard focus');
        await tapSuper(true);
        check(grid._map?.visible && grid._mapPinned, 'Super opens the grid while a fullscreen app has keyboard focus');
        check(!grid._superHeld, 'Fullscreen Super release clears held state');
        await tapSuper(false, Clutter.KEY_Super_R);
        await tapSuper(true, Clutter.KEY_Super_R);
        check(grid._map?.visible && grid._mapPinned && !grid._superHeld,
            'Right Super also toggles and releases correctly with fullscreen focus');
        // Click outside the map, in the fullscreen app, using real pointer input.
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), monitor.x + 30, monitor.y + 120);
        await wait(80);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await wait(40);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await wait(220);
        check(grid._map?.visible && grid._mapPinned, 'Clicking an app leaves the toggled grid open');
        await clickActor(this._fakeAI);
        check(this._fakeAI.menu.isOpen && grid._map?.visible && grid._mapPinned,
            'Notch AI menu opens above fullscreen without dismissing the grid');
        await clickActor(this._fakeAiItem);
        check(this._fakeAiMenuActions === 2 && grid._map?.visible && grid._mapPinned,
            'AI menu actions work while the fullscreen grid stays pinned');
        fullscreenWindow.unmake_fullscreen();
        await wait(350);
        check(fullscreenLauncherShows === 0 && !desktop.launcher.visible,
            `Fullscreen entry and exit never reveal the launcher over an occupied cell: shows=${fullscreenLauncherShows}`);
        grid._hideMap(true);
        fullscreenWorkspace.activate_with_focus(fullscreenWindow, global.get_current_time());
        fullscreenWindow.make_fullscreen();
        await wait(250);
        check(fullscreenWindow.is_fullscreen() && monitor.inFullscreen,
            'Application enters fullscreen again with the map closed');
        fullscreenWindow.unmake_fullscreen();
        await wait(250);
        desktop.launcher.disconnect(launcherVisibilityId);
        check(fullscreenLauncherShows === 0 && !desktop.launcher.visible && !grid._map,
            'Repeated fullscreen exit leaves both launcher and map closed');
        const fullscreenExitFocus = global.stage.get_key_focus();
        check(wm.get_active_workspace() === fullscreenWorkspace &&
            fullscreenWindow.get_workspace() === fullscreenWorkspace &&
            global.display.focus_window === fullscreenWindow &&
            (!fullscreenExitFocus || !desktop.launcher.contains(fullscreenExitFocus)),
        'Leaving fullscreen preserves the original workspace and application focus');
        grid.toggleGrid();
        // A different row viewport rebuilds the map; pin state must survive it.
        grid._setCount(15);
        grid._navigate('down');
        await wait(180);
        grid._navigate('down');
        await wait(180);
        grid._navigate('down');
        await wait(500);
        check(grid._map?.visible && grid._mapPinned,
            'Toggled grid stays open while navigating and rebuilding its row viewport');
        await tapSuper(false);
        check(!grid._map && !grid._mapPinned && !Main.overview.visible,
            'Second standalone Super closes the grid');
        wm.get_workspace_by_index(1).activate(global.get_current_time());
        grid._setCount(9);
        await wait(200);
        let chordCalls = 0;
        Main.wm.addKeybinding('test-super-chord', this.getSettings(), Meta.KeyBindingFlags.NONE,
            (await import('gi://Shell')).default.ActionMode.NORMAL, () => chordCalls++);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
        await wait(120);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_F12, Clutter.KeyState.PRESSED);
        await wait(80);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_F12, Clutter.KeyState.RELEASED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
        await wait(300);
        Main.wm.removeKeybinding('test-super-chord');
        check(chordCalls === 1, 'Unrelated Super chord retains its registered action');
        check(!grid._mapPinned && !grid._map, 'Unrelated Super chord does not leave the grid pinned');
        // Move-reduced operation must not retain a slide or block navigation.
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.set_boolean('enable-animations', false);
        await wait(100);
        grid._navigate('right');
        await wait(100);
        check(!grid._slide, 'Reduced motion skips workspace slide');
        grid._hideMap(true);
        desktop.goEmpty();
        await wait(220);
        check(desktop.launcher.visible, 'Plus button opens a blank workspace and launchpad');
        desktop.search.set_text('Grid Launch Verification');
        desktop.search.clutter_text.emit('activate');
        await wait(1200);
        const launched = [...grid._windows.keys()].find(w => w.get_title() === 'Grid launcher verification');
        check(launched && !desktop.launcher.visible, 'Enter launches a real app and hides the launchpad');
        // Create distant occupied cells and holes, then use the public reset action.
        grid._setCount(15);
        launched.change_workspace(global.workspace_manager.get_workspace_by_index(13));
        await wait(100);
        const beforeReset = new Set(grid._windows.keys());
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
        await wait(80);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
        await wait(250);
        const packed = [...grid._windows.keys()].map(w => w.get_workspace().index()).sort((a, b) => a - b);
        check(packed.every((value, i) => value === i), `Reset packs windows without holes: ${packed}`);
        check(beforeReset.size === grid._windows.size && [...beforeReset].every(w => grid._windows.has(w)),
            'Reset preserves every open window');
        check(global.workspace_manager.n_workspaces < 15, 'Reset removes unused rows');
        check(desktop.notch.visible && !desktop.launcher.visible, 'Notch remains after reset');
        const closingWorkspace = wm.get_active_workspace();
        const closingWindow = [...grid._windows.keys()].find(w => w.get_workspace() === closingWorkspace);
        const peers = new Map([...grid._windows.keys()].filter(w => w !== closingWindow)
            .map(w => [w, w.get_workspace().index()]));
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_r, Clutter.KeyState.PRESSED);
        await wait(700);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_r, Clutter.KeyState.RELEASED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
        await wait(200);
        check(!grid._windows.has(closingWindow), 'Super + Shift + R closes the current workspace window');
        check([...peers].every(([w, index]) => grid._windows.has(w) && w.get_workspace().index() === index),
            'Close shortcut preserves other workspaces, including windows of the same app');
        check(wm.get_active_workspace() === closingWorkspace && desktop.launcher.visible,
            'Close shortcut returns to the launcher in the same cell');
        desktop.search.set_text('test');
        grid.closeCurrentSpace();
        check(desktop.launcher.visible && desktop.search.get_text() === '',
            'Close shortcut on an empty cell resets launcher search');
        launched.delete(global.get_current_time());
        await wait(200);
        const loader = extension.stateObj;
        const originalManifest = JSON.parse(new TextDecoder().decode(
            extension.dir.get_child('current.json').load_contents(null)[1]));
        const liveWindows = new Map([...grid._windows].map(([window, state]) => [window, {
            cell: window.get_workspace().index(), original: state,
        }]));
        const activeCell = wm.get_active_workspace_index();
        const countBeforeUpdate = wm.n_workspaces;
        const dbusCall = async method => JSON.parse((await Gio.DBus.session.call(
            'org.gnome.Shell', '/dev/kanterlabs/Notchboard', 'dev.kanterlabs.Notchboard',
            method, null, new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 10000, null)).deep_unpack()[0]);
        const write = (file, text) => file.replace_contents(text, null, false, Gio.FileCreateFlags.NONE, null);
        const select = manifest => write(extension.dir.get_child('current.json'), JSON.stringify(manifest));
        const stageTestRelease = (label, activationError = false, importError = false) => {
            const revision = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, label, -1);
            const dir = extension.dir.get_child('releases').get_child(revision);
            dir.make_directory_with_parents(null);
            dir.get_child('schemas').make_directory(null);
            dir.get_child('icons').make_directory(null);
            const original = extension.dir.get_child('releases').get_child(originalManifest.revision);
            for (const file of ['runtime.js', 'desktop.js', 'bell.js', 'airpods.js', 'battery.js', 'power.js', 'grid.js', 'stylesheet.css', 'metadata.json',
                'schemas/org.gnome.shell.extensions.notchboard.gschema.xml', 'schemas/gschemas.compiled',
                'icons/notchboard-bell-symbolic.svg', 'icons/notchboard-bell-muted-symbolic.svg'])
                original.get_child(file).copy(dir.get_child(file), Gio.FileCopyFlags.NONE, null, null);
            const append = (file, text) => {
                const target = dir.get_child(file);
                write(target, new TextDecoder().decode(target.load_contents(null)[1]) + text);
            };
            append('grid.js', `\nexport const RELOAD_SENTINEL = '${label}-grid';\n`);
            append('desktop.js', `\nexport const DESKTOP_SENTINEL = '${label}-desktop';\n`);
            append('runtime.js', `\nimport {RELOAD_SENTINEL} from './grid.js';
import {DESKTOP_SENTINEL} from './desktop.js';
Notchboard.prototype.reloadSentinel = [RELOAD_SENTINEL, DESKTOP_SENTINEL];\n`);
            append('stylesheet.css', '\n.notchboard-notch { border-bottom-width: 4px; }\n');
            if (importError)
                append('runtime.js', "\nthrow new Error('deliberate import failure');\n");
            if (activationError)
                append('runtime.js', `\nconst originalEnable = Notchboard.prototype.enable;
Notchboard.prototype.enable = function () {
    originalEnable.call(this);
    throw new Error('deliberate activation failure');
};\n`);
            const manifest = {revision, version: originalManifest.version + 1};
            select(manifest);
            return manifest;
        };
        const firstStatus = await dbusCall('GetStatus');
        check(firstStatus.active && firstStatus.revision === originalManifest.revision,
            'Live status identifies the running release rather than installed metadata');
        const newManifest = stageTestRelease('hot-update');
        const hotStatus = await dbusCall('Reload');
        await wait(300);
        const updated = loader._runtime;
        check(updated !== grid && hotStatus.active && hotStatus.revision === newManifest.revision,
            'D-Bus update replaces the runtime in the same Shell session');
        check(updated.reloadSentinel.join(',') === 'hot-update-grid,hot-update-desktop',
            'Hot update refreshes both relative dependency modules');
        check(updated._desktop.notch.get_theme_node().get_border_width(St.Side.BOTTOM) === 4,
            'Hot update applies the new release stylesheet');
        check([...liveWindows].every(([w, state]) => updated._windows.get(w) === state.original &&
            w.get_workspace().index() === state.cell),
            'Hot update preserves open windows, cell positions and original restore records');
        check(wm.get_active_workspace_index() === activeCell && wm.n_workspaces === countBeforeUpdate,
            'Hot update preserves the active cell and grid dimensions');
        check((await dbusCall('Reload')).revision === newManifest.revision && loader._runtime === updated,
            'Reinstalling the same release leaves the runtime untouched');
        stageTestRelease('bad-import', false, true);
        let rejected = false;
        try { await dbusCall('Reload'); } catch (_) { rejected = true; }
        check(rejected && loader._runtime === updated && !updated._stopping,
            'Import failure leaves the working runtime running');
        stageTestRelease('bad-activation', true);
        rejected = false;
        try { await dbusCall('Reload'); } catch (_) { rejected = true; }
        await wait(250);
        check(rejected && loader._runtime === updated && !updated._stopping,
            'Activation failure rolls back to the previous working runtime');
        check([...liveWindows].every(([w, state]) => updated._windows.has(w) &&
            w.get_workspace().index() === state.cell), 'Rollback preserves every window and cell');
        select(originalManifest);
        await dbusCall('Reload');
        check((await dbusCall('GetStatus')).revision === originalManifest.revision,
            'A known release can be selected again after a rejected update');
        await Main.extensionManager.disableExtension('notchboard@kanterlabs.dev');
        await wait(400);
        check(grid._bindings.length === 0 && !grid._map && !grid._slide, 'Disable removes shortcuts, map and animation');
        check(grid._sources.size === 0 && grid._signals.length === 0, 'Disable removes sources and signals');
        check(grid._overlayHandler === 0, 'Disable releases ownership of the native Super handler');
        check(grid._superActions.size === 0, 'Disable releases both compositor Super accelerators');
        check(!grid._overlayCompositing, 'Disable releases overlay composition inhibition');
        await tapSuper();
        check(Main.overview.visible, 'Disabling Notchboard restores Super opening GNOME Overview');
        Main.overview.hide();
        await wait(350);
        check(desktop._signals.length === 0 && desktop._docks.size === 0 && !desktop.launcher,
            'Disable removes launchpad, notch, dock guards and UI signals');
        check(Main.layoutManager.panelBox.visible, 'Disabling Notchboard restores the full top bar');
        check(!Object.hasOwn(Main.osdWindowManager, 'showAll') && !Object.hasOwn(Main.osdWindowManager, 'showOne') &&
            !Object.hasOwn(Main.endSessionDialog, 'OpenAsync') && !Object.hasOwn(Main.endSessionDialog, 'Close') &&
            desktop.power._destroyed, 'Disabling Notchboard restores GNOME’s OSD and end-session dialog');
        check(Main.panel._rightBox.contains(this._fakeAI.container),
            'Disabling Notchboard returns AI usage to its original panel');
        const genericPolicy = new MessageTray.NotificationGenericPolicy();
        check(!globalThis[Symbol.for('notchboard-banner-hold')] && genericPolicy.showBanners === true,
            'Disabling Notchboard restores notification banners');
        genericPolicy.destroy();
        const settings = extension.stateObj.getSettings();
        check(settings.get_string('restore-state') === '', 'Recovery journal cleared after restoration');
        check(new Gio.Settings({schema_id: 'org.gnome.mutter'}).get_boolean('dynamic-workspaces'), 'Original dynamic workspaces restored');
        const differences = Object.entries(initialBindings).filter(([key, value]) =>
            (wmBindings.get_user_value(key)?.print(true) ?? null) !== value);
        if (!GLib.getenv('NOTCHBOARD_TEST_TILING'))
            check(differences.length === 0, `Original shortcuts and unset defaults restored exactly: ${JSON.stringify(differences)}`);
        check(journal.every(entry => (grid._schemaSettings(entry.schema)
            .get_user_value(entry.key)?.print(true) ?? null) === entry.user),
        'Every journaled setting restored, including extension shortcuts');
        // Simulate a settings journal left behind by an interrupted Shell.
        const savedMotion = iface.get_user_value('enable-animations')?.print(true) ?? null;
        iface.set_boolean('enable-animations', true);
        settings.set_string('restore-state', JSON.stringify([{schema: 'org.gnome.desktop.interface',
            key: 'enable-animations', user: savedMotion, applied: 'true'}]));
        await Main.extensionManager.enableExtension('notchboard@kanterlabs.dev');
        await wait(600);
        check(extension.state === 1 && !iface.get_boolean('enable-animations'),
            'Reactivation recovers settings from an interrupted prior session');
        const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        mutter.set_boolean('workspaces-only-on-primary', true);
        await Main.extensionManager.disableExtension('notchboard@kanterlabs.dev');
        await wait(400);
        check(mutter.get_user_value('workspaces-only-on-primary')?.deep_unpack() === true,
            'Disable preserves settings explicitly changed by the user');
        check(grid._sources.size === 0 && grid._signals.length === 0,
            'Repeated activation and cleanup leave no sources or signals');
        client.force_exit();
        this._report({passed: true, checks, screenshot: path});
    }
}
