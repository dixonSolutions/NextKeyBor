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

function windowActorFor(actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a instanceof Meta.WindowActor)
            return a;
    }
    return null;
}

// Chromium never enables text-input-v3 inside its popup surfaces (extension
// popups such as Bitwarden's, the omnibox dropdown), so no text input ever
// gets focus there and the check below finds nothing. The popup does hold
// keyboard focus, so the OSK's plain key events still reach it: open the OSK
// on a tap in a browser popup anyway, and close it again with the popup.
const POPUP_TYPES = [
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.MENU,
    Meta.WindowType.COMBO,
    Meta.WindowType.UTILITY,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];
const BROWSER_CLASS = /chrom|brave|vivaldi|edge|opera/i;

function browserPopup(window) {
    if (!window || !POPUP_TYPES.includes(window.get_window_type()))
        return false;
    const classOf = w => `${w?.get_wm_class() ?? ''} ${w?.get_gtk_application_id() ?? ''} ${w?.get_sandboxed_app_id() ?? ''}`;
    const parent = window.get_transient_for();
    return BROWSER_CLASS.test(classOf(window)) || BROWSER_CLASS.test(classOf(parent));
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
        this._forgetPopup();
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

        const windowActor = windowActorFor(global.stage.get_event_actor(event));
        if (!windowActor)
            return Clutter.EVENT_PROPAGATE;
        const window = windowActor.get_meta_window();
        const popup = browserPopup(window);

        CHECK_DELAYS_MS.forEach((delay, i) => {
            const last = i === CHECK_DELAYS_MS.length - 1;
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._timeouts.delete(id);
                if (!this._maybeOpen() && popup && last)
                    this._openForPopup(window);
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
        return Clutter.EVENT_PROPAGATE;
    }

    // True when a text input has focus (the OSK is then open or opening).
    _maybeOpen() {
        // currentFocus is set by mutter's focus_in for a Wayland client's
        // enabled text input and cleared again on disable (blur).
        if (!Main.inputMethod.currentFocus)
            return false;
        if (!Main.keyboard.visible)
            Main.keyboard.open(Main.layoutManager.focusIndex);
        return true;
    }

    _openForPopup(window) {
        console.log(`NextKeyBor: tap in browser popup (type ${window.get_window_type()}, ` +
            `class ${window.get_wm_class()}) with no text input focus; opening OSK`);
        if (!Main.keyboard.visible)
            Main.keyboard.open(Main.layoutManager.focusIndex);
        if (this._popupWindow === window)
            return;
        this._forgetPopup();
        this._popupWindow = window;
        this._popupUnmanagedId = window.connect('unmanaged', () => {
            this._forgetPopup();
            if (!Main.inputMethod.currentFocus)
                Main.keyboard.close();
        });
    }

    _forgetPopup() {
        if (this._popupWindow && this._popupUnmanagedId)
            this._popupWindow.disconnect(this._popupUnmanagedId);
        this._popupWindow = null;
        this._popupUnmanagedId = 0;
    }
}
