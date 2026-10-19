# Using Notchboard

One normal application window per GNOME workspace. Workspaces form a three-column grid; rows grow automatically, up to GNOME's 36-workspace limit. Positions remain stable when windows close. The nearest empty cell is reused for a new window. Dialogs, menus, sticky utility windows, and popup windows stay with their parent and are not assigned cells.

`Super` + arrows navigates. `Super` + `Shift` + arrows carries the focused window into an empty neighboring cell. Occupied cells and grid edges give a small nudge rather than wrapping or stacking windows. New normal windows are maximized and followed to their cell. Existing windows are organized on activation; their workspace and geometry are remembered until the extension is disabled.

The workspace moves with a 140 ms directional slide. A compact map contains live window thumbnails and app icons, with an animated selection ring. It stays up while Super is held and fades after release. Arrow keys repeat without queuing animations. The map shows up to three rows centered around the active row; click a tile to jump. GNOME's reduced-motion setting is respected. The Activities overview retains GNOME's normal workspace presentation; the floating map is the two-dimensional navigation view.

Notchboard replaces the bottom app dock with a centered launchpad on every empty workspace. Favorite and frequently used apps appear first; search matches all installed applications, including names and keywords. Arrow keys select results, Enter opens an app, and Escape clears the query. Existing single-window apps may return to their current window; apps that support new windows open one in the empty cell. The launchpad hides when a normal app or dialog occupies the workspace.

A Dynamic Island–style notch replaces the full-width top bar. It is a pure black pill that floats 6 px below the top edge and holds the miniature grid, the current time and one live panel indicator moved in from the hidden top bar (by default the AI Usage indicator, `ai-usage@laptopconfig`, when it is installed; set `hosted-indicator` to another status-area key, or empty for none). Hovering it, or switching workspaces, opens a drawer underneath for about 1.6 s with your row and column, `+` and `↻`. The top row stays in place while the drawer opens, and the drawer stays closed while that indicator's menu is open. Other panel indicators remain hidden. Clicking the hosted indicator opens its existing menu, and time follows the desktop's 12/24-hour setting. No new provider requests or credential handling are introduced by the notch.

Notification pop-ups are replaced by a bell at the right end of the island. While Notchboard is enabled, ordinary banners are suppressed; critical alerts such as low battery still pop up. Each arrival still plays its sound and makes the bell wiggle once while the island glows red, unless GNOME's Do Not Disturb or the app's own banner setting would have hidden the banner. A red badge counts unseen notifications, shown as 9+ above nine. Clicking the bell opens a black list under it, grouped by app with the newest first. Click a row to open it, ✕ dismisses it, and **Clear all** keeps resident notifications. The footer has Do Not Disturb and notification Settings. Opening the list marks everything as seen. Disabling Notchboard restores normal banners.

A 2 px line along the bottom of the island shows the laptop's charge as a share of the island's width. It is white on battery, green while charging or plugged in, and red at 20% or below, like iPhone's battery. The hover drawer adds the percentage and time left or time to full. It reads UPower's display device and does not appear on machines without a battery.

With [EarPort](https://github.com/Anoryth/earport) installed and AirPods connected, the island shows a headphones icon, a battery ring and the lowest charge of the buds in use, just before the bell. It turns red at 20% or below and shows ⚡ while charging. Clicking it opens a card with left, right and case battery, noise control for the modes the model supports, Conversation Awareness, and links to EarPort settings and Bluetooth. When the AirPods connect, a card briefly covers the island. Readings come from EarPort's daemon (`io.github.anoryth.EarPort`), which the island never auto-starts. Some AirPods, such as AirPods 4 (ANC), never send battery over that connection. In that case the island reads Apple's Bluetooth LE proximity broadcast (10% steps), filtered to the connected model. It does this in a scan of up to 8 s on connect, when the card opens, and at most every 5 minutes, and only while a battery is missing. Broadcast values are labelled approximate.

The island is shown at all times by default. To hide it, press `Super` + `Shift` + `H` or click the hide (eye) button in its hover drawer. Press the shortcut again to bring it back permanently. While hidden, touching the top edge of the screen above where the island sits slides it back down. It stays as long as the pointer is on it or one of its menus is open, then hides again. The choice is stored in the `notch-hidden` setting, so it survives reloads and logins. Hiding it also lets fullscreen apps bypass the Shell compositor again when nothing else from Notchboard is on screen. The hidden panel's reserved space is released, so maximized windows reach the top edge. Disabling Notchboard returns the hosted indicator to its original panel position and restores the full bar.

The visible notch, map and launcher keep Shell compositing enabled so direct scanout cannot bypass their rendering. Maps and launchers enter fully opaque with a short slide; interactive grids never start transparent. This composition inhibition is released on lock or disable.

The grid shows your row and column and whether the current cell is empty. Click its grid to pin the larger thumbnail map; click again, press Super, or press Escape to dismiss. Clicking apps or the AI menu keeps the toggled map open. The notch and map stay above app windows, including fullscreen windows and application popups. `+` jumps to the nearest empty cell and focuses search. The notch's `↻`, the launchpad's **Reset grid**, and `Super` + `Shift` + `Backspace` all pack windows into consecutive cells and remove unused rows. Reset never closes applications. The grid keeps at least two rows and a spare cell where capacity permits.

Dash to Dock and the default GNOME dash are hidden only while Notchboard is active, including their reserved screen area. No permanent dock settings are changed. Disabling Notchboard removes the notch and launchpad and restores the docks' previous visibility.

All monitors share the same workspace grid. Windows keep their original monitor; a cell contains one normal window across the monitor set. At the 36-window limit, extra windows retain normal GNOME behavior and a notification explains that a cell must be freed.

`Super` + `Shift` + `R` closes normal app windows in the current workspace and reveals that cell's app launcher. Windows on other workspaces, including other windows of the same app, stay open. This sends standard window close requests, so save/cancel prompts can keep a window open; the launcher appears once the workspace is empty. Holding the shortcut does not repeat the close action. On an already empty workspace it clears and focuses launcher search. `Super` + `Shift` + `Backspace` continues to reset the overall layout without closing apps.

## Installation

A standalone press of `Super` toggles the workspace grid on **key-down**, without waiting for release or an arrow key; press `Super` again to close it. The toggled grid stays visible after key release and while navigating with `Super` + arrows, including when its visible rows change. The notch's grid button uses the same toggle. Mutter's standalone overlay-key interception is temporarily disabled so compositor accelerators handle the press immediately, including when a fullscreen application has keyboard focus; disabling Notchboard releases both Super accelerators and restores the original setting and native handler. Modifier release is checked only while Super is held, since focused Wayland clients may consume release events too. Other Super shortcuts still work.

Run `make install` to install, or to update a running copy in place. The very first install needs one logout so GNOME Shell discovers the extension; after that no logout is needed. The command prints the actual running version and release hash after activation. Check it independently with `make status`.

Notchboard uses a small stable entry point and immutable, content-addressed release directories. Each update reloads the runtime, its relative helper modules, styles and settings schema together. The loader preserves window identities, workspace cells, the active cell, grid dimensions and original restore records. Syntax/import failures leave the working runtime untouched; activation failures restore it. The installer also reselects the working release on disk after a rejected update. Reinstalling identical files does nothing to the running UI.

The installer backs up workspace settings and the enabled/disabled extension lists under `~/.local/state/notchboard/backups/`. It enables only this extension and preserves unrelated enabled extensions. At runtime the extension claims only Super-arrow and Super-Shift-arrow bindings from GNOME and Tiling Assistant, preserving their other shortcuts. It manages workspaces and window placement, not Tiling Assistant's mouse-driven tiling.

Disable with `gnome-extensions disable notchboard@kanterlabs.dev` or GNOME Extensions. The extension returns still-open windows to their original workspace/geometry, restores the prior layout and settings, and removes its map and animations. Settings use a persistent recovery journal; original user values, including unset defaults, are restored unless the user has changed the setting since the extension applied it. After an interrupted Shell session, the next activation recovers that journal before taking ownership again.

To recover saved settings if the extension cannot load, run `python3 scripts/restore.py`. This disables Notchboard and restores only its journaled settings; it does not reset anything else.

## Tuning and checks

```
gsettings --schemadir ~/.local/share/gnome-shell/extensions/notchboard@kanterlabs.dev/schemas set org.gnome.shell.extensions.notchboard animation-ms 140
make test
make test-shell
# Also exercise coexistence with the installed Tiling Assistant:
NOTCHBOARD_TEST_TILING=1 make test-shell
# Include Dash to Dock and exercise hiding/restoration:
NOTCHBOARD_TEST_TILING=1 NOTCHBOARD_TEST_DOCK=1 make test-shell
```

Compatibility is deliberately limited to GNOME Shell 49, whose actual installed APIs were inspected. The live status endpoint verifies which runtime is active; isolated tests exercise real GTK windows, keyboard and pointer input, live updates, rollback and migration.
