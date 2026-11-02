import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export async function checkCodes({desktop, check, wait, clickActor, pointer, capture}) {
    const prompt = desktop.codePrompt;
    const clipboard = St.Clipboard.get_default();
    const readClipboard = () => new Promise(resolve =>
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text)));
    const away = async () => {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 700, 450);
        global.stage.set_key_focus(null);
        await wait(100);
    };
    const source = new MessageTray.Source({title: 'Google Chrome', iconName: 'mail-unread-symbolic'});
    Main.messageTray.add(source);
    const send = (body, extra = {}) => {
        const notification = new MessageTray.Notification({source, title: 'Gmail · Google', body, ...extra});
        source.addNotification(notification);
        return notification;
    };
    await away();
    await wait(400);
    const height = desktop.notch.height;
    clipboard.set_text(St.ClipboardType.CLIPBOARD, 'clipboard sentinel');
    const first = send('G-482913 is your Google verification code.');
    await wait(650);
    check(prompt.active && prompt.actor.mapped && prompt._code === '482913' &&
        desktop.notch.height > height && !desktop.expanded,
    'Verification notification expands the code panel beneath the compact row');
    check(await readClipboard() === 'clipboard sentinel', 'Code arrival never changes the clipboard');
    check(!Main.messageTray._notification && desktop._clockLabel.mapped,
        'Code offer keeps the clock visible without a second notification banner');
    const [copyX, copyY] = prompt._copy.get_transformed_position();
    const [notchX, notchY] = desktop.notch.get_transformed_position();
    check(copyX >= notchX && copyX + prompt._copy.width <= notchX + desktop.notch.width &&
        copyY + prompt._copy.height <= notchY + desktop.notch.height,
    'Copy button is fully allocated inside the expanded notch');
    await capture('copy-code');
    await clickActor(prompt._copy);
    check(await readClipboard() === '482913' && prompt._copy.label === '✓ Copied',
        'Clicking Copy code writes just the digits and shows Copied');
    check(!global.stage.get_key_focus() || !prompt.actor.contains(global.stage.get_key_focus()),
        'Copy releases code-control focus so the application can receive paste immediately');
    await capture('code-copied');
    await wait(1800);
    check(!prompt.active && !prompt.actor.visible && prompt._code === null,
        'Copied confirmation collapses and clears the transient code');
    check(source.notifications.includes(first), 'Copying leaves the original notification available');
    await away();
    const second = send('Your security code is 004200.');
    await wait(500);
    const third = send('Your security code is 000123.');
    first.destroy();
    second.destroy();
    await wait(500);
    check(prompt.active && prompt._code === '000123',
        'Newest code replaces the old one and old notification removal cannot dismiss it');
    third.body = 'Code replaced by a newer email';
    await wait(400);
    check(!prompt.active && !prompt.actor.visible, 'Changed notification text clears the stale code');

    send('Your login code is 918273.');
    await wait(500);
    prompt._copy.grab_key_focus();
    prompt._remaining = 150;
    await wait(400);
    check(prompt.active && prompt._remaining > 0, 'Keyboard focus pauses the code countdown');
    await away();
    await wait(500);
    check(!prompt.active && !prompt.actor.visible, 'Code expires when interaction ends');
    send('Your verification code is 654321.');
    await wait(500);
    await clickActor(prompt._dismiss);
    await wait(400);
    check(!prompt.active && await readClipboard() === '482913',
        'Dismiss collapses without replacing the clipboard');
    await away();
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    settings.set_boolean('show-banners', false);
    send('Your verification code is 123456.');
    await wait(200);
    check(!prompt.active, 'Do Not Disturb suppresses code offers');
    settings.reset('show-banners');
    send('Your verification code is 665544.');
    await wait(200);
    settings.set_boolean('show-banners', false);
    await wait(100);
    check(!prompt.active && !prompt.actor.visible, 'Enabling Do Not Disturb clears an existing code');
    settings.reset('show-banners');
    send('Your verification code is 778899.');
    await wait(400);
    desktop.bell.toggle();
    await wait(400);
    check(!prompt.active && desktop.bell.menu.isOpen, 'Opening notifications dismisses the code panel');
    desktop.bell.menu.close();
    send('Your verification code is 778800.');
    await wait(200);
    const locked = Main.sessionMode.isLocked;
    try {
        // Exercise the same visibility sync used by session-mode updates,
        // without launching a password dialog in the headless compositor.
        Main.sessionMode.isLocked = true;
        desktop.sync();
        check(!prompt.active && !prompt.actor.visible && !prompt._code,
            'Lock-state sync immediately clears the code panel');
        send('Your verification code is 998877.');
        check(!prompt.active, 'Locked sessions do not offer new codes');
    } finally {
        Main.sessionMode.isLocked = locked;
        desktop.sync();
    }
    await wait(400);
    desktop.toggleNotch();
    await wait(400);
    send('Your verification code is 321654.');
    await wait(200);
    check(!prompt.active && !desktop.notch.visible, 'Code offers do not reveal a manually hidden island');
    desktop.toggleNotch();
    await wait(400);
    send('Order 123456 has shipped.');
    await wait(100);
    check(!prompt.active, 'Ordinary notification numbers do not create code offers');

    send('Your verification code is 112233.');
    await wait(500);
    desktop.toggleNotch();
    await wait(400);
    check(!prompt.active && prompt._code === null, 'Hiding the island clears an existing code offer');
    desktop.toggleNotch();
    await wait(400);
    const animations = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const oldAnimations = animations.get_boolean('enable-animations');
    animations.set_boolean('enable-animations', false);
    send('Your one-time code is 223344.');
    await wait(120);
    check(prompt.actor.visible && prompt._digits.get_children().every(digit => digit.opacity === 255),
        'Reduced motion immediately reveals all code digits');
    send('Here is the Steam Guard code you need to access your account: Request made from New York, United States A7B2C',
        {title: 'Your Steam account: Access from new web or mobile device'});
    await wait(120);
    check(prompt.active && prompt._code === 'A7B2C' && prompt._digits.get_n_children() === 5,
        'Steam Guard notification previews show all five alphanumeric code characters');
    await clickActor(prompt._copy);
    check(await readClipboard() === 'A7B2C', 'Steam Guard copy preserves uppercase letters and digits');
    source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    await wait(100);
    check(!prompt.active && !prompt.actor.visible && !prompt._timer,
        'Source destruction removes the code and its timer, including with reduced motion');
    animations.set_boolean('enable-animations', oldAnimations);
    await away();
}
