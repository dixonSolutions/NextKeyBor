// Fixes for the stock GNOME Shell on-screen keyboard (supersede the
// osk-tap-fix@surface.local extension).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Terminals (VTE) and most Chromium/Qt fields report empty surrounding text,
// which the stock OSK reads as "start of the buffer" and so latches Shift
// after every backspace or key. Only auto-capitalize an empty buffer when the
// field was just focused, not right after the user typed into it.
export function updateLevelFromHints(userInputHappened) {
    if (this._latched)
        return;

    const hint = this._contentHint;
    const Hints = Clutter.InputContentHintFlags;
    if (hint & Hints.LOWERCASE) {
        this._setActiveLevel('default');
        return;
    }
    if (!this._layers['shift'])
        return;
    if (hint & Hints.UPPERCASE) {
        this._setActiveLevel('shift');
        return;
    }
    if (hint & (Hints.AUTO_CAPITALIZATION | Hints.TITLECASE)) {
        if (this._surroundingTextId)
            return;
        this._surroundingTextId = Main.inputMethod.connect('surrounding-text-set', () => {
            Main.inputMethod.disconnect(this._surroundingTextId);
            this._surroundingTextId = 0;

            const [text, cursor] = Main.inputMethod.getSurroundingText();
            if (!text || cursor === 0) {
                this._setActiveLevel(userInputHappened ? 'default' : 'shift');
                return;
            }
            const before = GLib.utf8_substring(text, 0, cursor);
            let shift;
            if (hint & Hints.TITLECASE)
                shift = before.endsWith(' ');
            else
                shift = /[.!?]\s+$/.test(before);
            this._setActiveLevel(shift ? 'shift' : 'default');
        });
        Main.inputMethod.request_surrounding();
        return;
    }
    if (userInputHappened && this._currentPage === this._layers['shift'])
        this._setActiveLevel('default');
}

// The app sends text_input_v3.enable only after it has processed the tap, so
// look for the focused text input a little later, then once more for slow apps.
const CHECK_DELAYS_MS = [120, 450];

const TOUCH_DEVICE_TYPES = [
    Clutter.InputDeviceType.TOUCHSCREEN_DEVICE,
    Clutter.InputDeviceType.TABLET_DEVICE,
    Clutter.InputDeviceType.PEN_DEVICE,
    Clutter.InputDeviceType.ERASER_DEVICE,
];

function isOnAppWindow(actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a instanceof Meta.WindowActor)
            return true;
    }
    return false;
}

// Mutter only raises the OSK for text-input-v3 version 1 clients when they
// re-send enable on an already focused field, which GTK does on every tap but
// Chromium, Electron and Qt never do. Open it ourselves after a touch/pen tap
// on a window when a text input has focus.
export class TapFix {
    constructor() {
        this._timeouts = new Set();
        this._eventId = global.stage.connect('captured-event',
            (_stage, event) => this._onEvent(event));
    }

    destroy() {
        global.stage.disconnect(this._eventId);
        this._eventId = 0;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.TOUCH_END &&
            type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        const deviceType = event.get_source_device()?.get_device_type();
        if (!TOUCH_DEVICE_TYPES.includes(deviceType))
            return Clutter.EVENT_PROPAGATE;

        if (!isOnAppWindow(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;

        for (const delay of CHECK_DELAYS_MS) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._timeouts.delete(id);
                this._maybeOpen();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _maybeOpen() {
        // currentFocus is set by mutter's focus_in for a Wayland client's
        // enabled text input and cleared again on disable (blur).
        if (!Main.inputMethod.currentFocus || Main.keyboard.visible)
            return;
        Main.keyboard.open(Main.layoutManager.focusIndex);
    }
}
