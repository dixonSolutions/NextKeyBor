// NextKeyBor: extends the GNOME Shell on-screen keyboard.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Keyboard} from 'resource:///org/gnome/shell/ui/keyboard.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DaemonClient} from './lib/daemon.js';
import {TapFix, updateLevelFromHints} from './lib/fixes.js';
import {augmentRow} from './lib/holds.js';
import {KeyboardUi} from './lib/keyboardUi.js';

const MAX_HEIGHT_RATIO = 0.62;

export default class NextKeyBorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._daemon = new DaemonClient(this.dir);
        this._uis = new Map(); // Keyboard -> KeyboardUi
        this._tapFix = null;

        this._patchKeyboard();

        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'chromium-tap-fix')
                this._syncTapFix();
            else if (key === 'hold-for-numbers')
                this._rebuildKeys();
        }, this);
        this._syncTapFix();

        const kb = Main.keyboard._keyboard;
        if (kb) {
            this._inject(kb);
            this._rebuildKeys();
        }
    }

    disable() {
        this._settings.disconnectObject(this);
        this._tapFix?.destroy();
        this._tapFix = null;

        for (const [kb, ui] of this._uis) {
            if (!kb._nkbDestroyed)
                kb.disconnectObject(this);
            ui.destroy();
        }
        this._uis.clear();

        this._unpatchKeyboard();
        this._rebuildKeys();
        Main.keyboard._keyboard?._relayout();

        this._daemon.destroy();
        this._daemon = null;
        this._settings = null;
        this._uis = null;
    }

    _syncTapFix() {
        const want = this._settings.get_boolean('chromium-tap-fix');
        if (want && !this._tapFix)
            this._tapFix = new TapFix();
        else if (!want && this._tapFix) {
            this._tapFix.destroy();
            this._tapFix = null;
        }
    }

    _rebuildKeys() {
        try {
            Main.keyboard._keyboard?._updateKeys();
        } catch (e) {
            console.error(`NextKeyBor: rebuilding keys failed: ${e}`);
        }
    }

    _patchKeyboard() {
        const proto = Keyboard.prototype;
        const ext = this;
        const settings = this._settings;
        this._orig = {
            _setupKeyboard: proto._setupKeyboard,
            _relayout: proto._relayout,
            _addRowKeys: proto._addRowKeys,
            _updateLevelFromHints: proto._updateLevelFromHints,
        };
        const orig = this._orig;

        proto._setupKeyboard = function (...args) {
            orig._setupKeyboard.apply(this, args);
            ext._inject(this);
        };

        proto._relayout = function (...args) {
            orig._relayout.apply(this, args);
            this._nkbBaseHeight = this.height;
            const extra = ext._uis?.get(this)?.extraHeight ?? 0;
            const monitor = Main.layoutManager.keyboardMonitor;
            if (extra > 0 && monitor)
                this.height = Math.min(this.height + extra, monitor.height * MAX_HEIGHT_RATIO);
        };

        proto._addRowKeys = function (keys, layout, ...rest) {
            if (settings.get_boolean('hold-for-numbers')) {
                try {
                    augmentRow(keys, layout._nRows, layout.mode);
                } catch (e) {
                    console.error(`NextKeyBor: long-press variants failed: ${e}`);
                }
            }
            return orig._addRowKeys.call(this, keys, layout, ...rest);
        };

        proto._updateLevelFromHints = function (...args) {
            if (settings.get_boolean('fix-auto-capitalization'))
                return updateLevelFromHints.apply(this, args);
            return orig._updateLevelFromHints.apply(this, args);
        };
    }

    _unpatchKeyboard() {
        const proto = Keyboard.prototype;
        for (const [name, fn] of Object.entries(this._orig ?? {}))
            proto[name] = fn;
        this._orig = null;
    }

    _inject(kb) {
        if (!this._uis || this._uis.has(kb))
            return;
        try {
            const ui = new KeyboardUi(kb, {
                settings: this._settings,
                daemon: this._daemon,
                openPreferences: () => {
                    kb.close(true);
                    this.openPreferences();
                },
            });
            this._uis.set(kb, ui);
            kb.connectObject('destroy', () => {
                kb._nkbDestroyed = true;
                const u = this._uis?.get(kb);
                if (u) {
                    this._uis.delete(kb);
                    u.destroy();
                }
            }, this);
        } catch (e) {
            console.error(`NextKeyBor: could not extend the on-screen keyboard: ${e}\n${e.stack}`);
        }
    }
}
