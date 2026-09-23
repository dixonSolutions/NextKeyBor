// Small touch-friendly building blocks. The stock OSK handles press/release
// and touch events itself (it lives in a chrome actor, and keys must fire on
// touch without waiting for click gestures), so we do the same.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const LONG_PRESS_MS = 450;
const TAP_SLOP_PX = 18;

// Calls onTap on release, or onLongPress (if given) after holding. Tap is
// cancelled if the pointer/finger moved (so scroll views can be dragged).
export function connectTap(actor, {onTap, onLongPress = null, longPressMs = LONG_PRESS_MS}) {
    let timeoutId = 0;
    let longFired = false;
    let start = null;
    let slot = null;

    const clearTimer = () => {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
    };
    const press = event => {
        longFired = false;
        start = event.get_coords();
        actor.add_style_pseudo_class('active');
        clearTimer();
        if (onLongPress) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, longPressMs, () => {
                timeoutId = 0;
                longFired = true;
                actor.remove_style_pseudo_class('active');
                onLongPress();
                return GLib.SOURCE_REMOVE;
            });
        }
    };
    const moved = event => {
        if (!start)
            return true;
        const [x, y] = event.get_coords();
        return Math.abs(x - start[0]) > TAP_SLOP_PX || Math.abs(y - start[1]) > TAP_SLOP_PX;
    };
    const release = event => {
        clearTimer();
        actor.remove_style_pseudo_class('active');
        const wasMove = moved(event);
        start = null;
        if (!longFired && !wasMove)
            onTap?.();
    };

    actor.reactive = true;
    actor.connect('button-press-event', (_a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        press(event);
        return Clutter.EVENT_STOP;
    });
    actor.connect('button-release-event', (_a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        release(event);
        return Clutter.EVENT_STOP;
    });
    actor.connect('motion-event', (_a, event) => {
        if (start && moved(event)) {
            clearTimer();
            actor.remove_style_pseudo_class('active');
        }
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('touch-event', (_a, event) => {
        const type = event.type();
        const s = event.get_event_sequence()?.get_slot();
        if (type === Clutter.EventType.TOUCH_BEGIN && slot === null) {
            slot = s;
            press(event);
        } else if (type === Clutter.EventType.TOUCH_UPDATE && s === slot) {
            if (moved(event)) {
                clearTimer();
                actor.remove_style_pseudo_class('active');
            }
            return Clutter.EVENT_PROPAGATE;
        } else if ((type === Clutter.EventType.TOUCH_END ||
                    type === Clutter.EventType.TOUCH_CANCEL) && s === slot) {
            slot = null;
            if (type === Clutter.EventType.TOUCH_END) {
                release(event);
            } else {
                clearTimer();
                start = null;
                actor.remove_style_pseudo_class('active');
            }
        }
        return Clutter.EVENT_STOP;
    });
    actor.connect('destroy', clearTimer);
}

export function iconButton(iconName, {styleClass = '', accessibleName = '', onTap, onLongPress} = {}) {
    const button = new St.Button({
        style_class: `nkb-tool-button ${styleClass}`,
        child: new St.Icon({icon_name: iconName}),
        accessible_name: accessibleName,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
    connectTap(button, {onTap, onLongPress});
    return button;
}

export function labelButton(label, {styleClass = '', onTap, onLongPress} = {}) {
    const button = new St.Button({
        style_class: `nkb-tool-button ${styleClass}`,
        label,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
    connectTap(button, {onTap, onLongPress});
    return button;
}

export function setChecked(button, checked) {
    if (checked)
        button.add_style_pseudo_class('checked');
    else
        button.remove_style_pseudo_class('checked');
}
