// Everything NextKeyBor adds to one instance of the stock OSK: the toolbar,
// the panel host, the hooks on its KeyboardController, text tracking for
// suggestions, dictation and media pasting. destroy() puts the stock
// keyboard back exactly as it was.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {waitForSignal} from './daemon.js';
import {EmojiPanel, LanguagePanel, MediaPanel} from './panels.js';
import {connectTap, iconButton, labelButton, setChecked} from './widgets.js';

const MAX_SUGGESTIONS = 3;
const MAX_BUFFER = 400;
const SUGGEST_DELAY_MS = 90;
const LEARN_WORD_BATCH = 8;
const MEDIA_READY_TIMEOUT_MS = 30000;
const LONG_DELETE_MS = 600;
const STRIP_RATIO = 0.6;

const WORD_TAIL = /[\p{L}\p{N}_'’-]*$/u;
const TERMINAL_WM_CLASS = /term|console|ptyxis|kitty|alacritty|wezterm|foot|konsole|tilix|terminator|blackbox|guake|tilda/i;

function lastWord(text) {
    return text.match(WORD_TAIL)[0];
}

function matchCase(word, partial) {
    if (!partial)
        return word;
    const first = [...partial][0];
    if (partial.length > 1 && partial === partial.toUpperCase() && partial !== partial.toLowerCase())
        return word.toUpperCase();
    if (first !== first.toLowerCase())
        return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
}

function loadBytes(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                const [, contents] = file.load_contents_finish(res);
                resolve(contents);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class KeyboardUi {
    constructor(keyboard, {settings, daemon, openPreferences}) {
        this._kb = keyboard;
        this._settings = settings;
        this._daemon = daemon;
        this._openPreferences = openPreferences;

        this._panel = null;
        this._buffer = '';
        this._pendingLearn = '';
        this._lastCommitTime = 0;
        this._lastSurroundingTime = 0;
        this._suggestId = 0;
        this._suggestSerial = 0;
        this._capDeleteDown = false;
        this._swallowRelease = false;
        this._deletePressTime = 0;
        this._dictation = {id: null, state: 'idle'};
        this.extraHeight = 0;

        this._buildToolbar();
        this._buildPanelHost();
        this._hookController();

        Main.inputMethod.connectObject('surrounding-text-set', () => {
            this._lastSurroundingTime = GLib.get_monotonic_time();
            this._scheduleSuggest(20);
        }, this);

        keyboard._focusTracker?.connectObject(
            'focus-changed', () => this._resetText(),
            'window-changed', () => this._resetText(), this);
        keyboard._keyboardController.connectObject(
            'purpose-changed', () => {
                this._resetText();
                this._syncVisibility();
            }, this);
        keyboard.connectObject('visibility-changed', () => {
            if (!keyboard.visible) {
                this.closePanel();
                this._flushLearn();
            } else {
                this._scheduleSuggest(0);
            }
        }, this);

        daemon.connectObject(
            'available-changed', () => this._syncVisibility(),
            'DictationState', (_d, id, state) => this._onDictationState(id, state),
            'DictationLevel', (_d, level) => this._onDictationLevel(level),
            'DictationResult', (_d, id, text) => this._onDictationResult(id, text),
            'DictationError', (_d, id, message) => this._onDictationError(id, message),
            this);

        settings.connectObject('changed', (_s, key) => {
            if (key === 'speech-language')
                this._syncMicLabel();
            if (key === 'suggestions-enabled')
                this._syncVisibility();
        }, this);

        this._syncMicLabel();
        this._syncVisibility();
    }

    destroy() {
        this._destroyed = true;
        this._flushLearn();
        if (this._suggestId)
            GLib.source_remove(this._suggestId);
        this._suggestId = 0;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
        if (this._dictation.id && this._dictation.state === 'recording')
            this._daemon.cancelDictation(this._dictation.id).catch(() => {});

        Main.inputMethod.disconnectObject(this);
        this._daemon.disconnectObject(this);
        this._settings.disconnectObject(this);

        const kb = this._kb;
        const alive = !kb._nkbDestroyed;
        if (alive) {
            kb._focusTracker?.disconnectObject(this);
            kb._keyboardController?.disconnectObject(this);
            kb.disconnectObject(this);
            this._unhookController();
            this.closePanel();
            this._toolbar.destroy();
            this._panelHost.destroy();
            if (kb._suggestions) {
                kb._suggestions.disconnectObject(this);
                kb._suggestions.visible = true;
            }
            kb._aspectContainer?.show();
        }
        this.extraHeight = 0;
        this._kb = null;
    }

    // ---- toolbar ---------------------------------------------------------

    _buildToolbar() {
        const kb = this._kb;
        this._toolbar = new St.BoxLayout({style_class: 'nkb-toolbar', x_expand: true});

        this._micButton = new St.Button({
            style_class: 'nkb-tool-button nkb-mic',
            can_focus: false,
            accessible_name: 'Dictate',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const micBox = new St.BoxLayout({style_class: 'nkb-mic-box'});
        this._micIcon = new St.Icon({icon_name: 'audio-input-microphone-symbolic'});
        this._micLabel = new St.Label({style_class: 'nkb-mic-label', y_align: Clutter.ActorAlign.CENTER});
        micBox.add_child(this._micIcon);
        micBox.add_child(this._micLabel);
        this._micButton.child = micBox;
        connectTap(this._micButton, {
            onTap: () => this._toggleDictation(),
            onLongPress: () => this.openPanel('language', 'speech'),
        });
        this._toolbar.add_child(this._micButton);

        this._langButton = iconButton('preferences-desktop-locale-symbolic', {
            accessibleName: 'Languages',
            onTap: () => this.togglePanel('language', 'layouts'),
        });
        this._toolbar.add_child(this._langButton);

        this._center = new St.BoxLayout({
            style_class: 'nkb-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._suggestionBox = new St.BoxLayout({
            style_class: 'nkb-suggestions',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel = new St.Label({
            style_class: 'nkb-toolbar-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._center.add_child(this._suggestionBox);
        this._center.add_child(this._statusLabel);
        this._toolbar.add_child(this._center);

        this._emojiButton = iconButton('face-smile-symbolic', {
            accessibleName: 'Search emoji and symbols',
            onTap: () => this.togglePanel('emoji'),
        });
        this._gifButton = labelButton('GIF', {
            styleClass: 'nkb-gif-button',
            onTap: () => this.togglePanel('gif'),
        });
        this._stickerButton = iconButton('image-x-generic-symbolic', {
            accessibleName: 'Stickers',
            onTap: () => this.togglePanel('sticker'),
        });
        this._settingsButton = iconButton('emblem-system-symbolic', {
            accessibleName: 'NextKeyBor settings',
            onTap: () => this._openPreferences(),
        });
        for (const b of [this._emojiButton, this._gifButton, this._stickerButton, this._settingsButton])
            this._toolbar.add_child(b);

        kb.insert_child_at_index(this._toolbar, 0);

        // The stock suggestions row is only used by IBus engines; keep it out
        // of the way unless it has something to show.
        if (kb._suggestions) {
            const sync = () => {
                kb._suggestions.visible = kb._suggestions.get_n_children() > 0;
            };
            kb._suggestions.connectObject(
                'child-added', sync, 'child-removed', sync, this);
            sync();
        }
    }

    _syncVisibility() {
        const available = this._daemon.available;
        const password = this._isPassword();
        for (const b of [this._micButton, this._emojiButton, this._gifButton, this._stickerButton]) {
            b.reactive = available;
            b.opacity = available ? 255 : 100;
        }
        this._micButton.visible = !password;
        this._suggestionBox.visible = available && !password && !this._panel &&
            this._settings.get_boolean('suggestions-enabled');
        if (!this._suggestionBox.visible)
            this._suggestionBox.destroy_all_children();
    }

    _syncMicLabel() {
        const lang = this._settings.get_string('speech-language');
        this._micLabel.text = lang === 'auto' ? '' : lang.toUpperCase();
        this._micLabel.visible = lang !== 'auto';
    }

    _showToolbarStatus(text) {
        this._statusLabel.text = text ?? '';
        this._statusLabel.visible = !!text;
        this._suggestionBox.visible = !text && this._daemon.available && !this._isPassword() &&
            !this._panel && this._settings.get_boolean('suggestions-enabled');
    }

    // ---- panels ----------------------------------------------------------

    _buildPanelHost() {
        this._panelHost = new St.Bin({
            style_class: 'nkb-panel-host',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            visible: false,
        });
        this._kb.insert_child_above(this._panelHost, this._toolbar);
    }

    togglePanel(name, tab) {
        if (this._panelName === name)
            this.closePanel();
        else
            this.openPanel(name, tab);
    }

    openPanel(name, tab) {
        this.closePanel();
        let panel;
        if (name === 'emoji') {
            panel = new EmojiPanel(this._daemon, {commit: str => this._commitToApp(str)});
        } else if (name === 'gif' || name === 'sticker') {
            panel = new MediaPanel(this._daemon, this._settings, {
                kind: name,
                paste: item => this._pasteMedia(item),
                openPreferences: this._openPreferences,
            });
        } else if (name === 'language') {
            panel = new LanguagePanel(this._daemon, this._settings);
        } else {
            return;
        }
        if (tab)
            panel.setTab(tab);
        this._panel = panel;
        this._panelName = name;
        panel.connect('close-request', () => this.closePanel());
        panel.connect('expanded-changed', () => this._layoutPanel());
        this._panelHost.child = panel;
        this._panelHost.show();

        setChecked(this._emojiButton, name === 'emoji');
        setChecked(this._gifButton, name === 'gif');
        setChecked(this._stickerButton, name === 'sticker');
        setChecked(this._langButton, name === 'language');
        this._syncVisibility();
        this._layoutPanel();
    }

    closePanel() {
        if (!this._panel)
            return;
        const panel = this._panel;
        this._panel = null;
        this._panelName = null;
        this._capDeleteDown = false;
        this._panelHost.child = null;
        panel.destroy();
        this._panelHost.hide();
        for (const b of [this._emojiButton, this._gifButton, this._stickerButton, this._langButton])
            setChecked(b, false);
        this._kb._aspectContainer?.show();
        this._setExtraHeight(0);
        this._syncVisibility();
        this._scheduleSuggest(0);
    }

    _layoutPanel() {
        const panel = this._panel;
        if (!panel)
            return;
        const base = this._kb._nkbBaseHeight || this._kb.height;
        if (panel.expanded) {
            this._kb._aspectContainer?.hide();
            this._panelHost.y_expand = true;
            this._panelHost.height = -1;
            this._setExtraHeight(Math.round(base * 0.5));
        } else {
            this._kb._aspectContainer?.show();
            this._panelHost.y_expand = false;
            const strip = Math.round(base * STRIP_RATIO);
            this._panelHost.height = strip;
            this._setExtraHeight(strip);
        }
    }

    _setExtraHeight(extra) {
        if (this.extraHeight === extra)
            return;
        this.extraHeight = extra;
        this._kb._relayout();
    }

    // ---- controller hooks (captured typing + text tracking) ---------------

    _hookController() {
        const ctrl = this._kb._keyboardController;
        this._ctrl = ctrl;
        this._orig = {
            commit: ctrl.commit,
            toggleDelete: ctrl.toggleDelete,
            keyvalPress: ctrl.keyvalPress,
            keyvalRelease: ctrl.keyvalRelease,
        };

        ctrl.commit = (str, modifiers) => {
            if (this._panel?.capturesTyping) {
                this._panel.typeText(str);
                return Promise.resolve();
            }
            const plain = !modifiers || modifiers.size === 0;
            const promise = this._orig.commit.call(ctrl, str, modifiers);
            if (plain)
                this._onTextCommitted(str);
            else
                this._resetText();
            return promise;
        };

        ctrl.toggleDelete = enabled => {
            if (this._panel?.capturesTyping) {
                if (enabled && !this._capDeleteDown)
                    this._panel.backspace();
                this._capDeleteDown = enabled;
                return;
            }
            const wasEnabled = ctrl._deleteEnabled;
            this._orig.toggleDelete.call(ctrl, enabled);
            if (enabled && !wasEnabled) {
                this._deletePressTime = GLib.get_monotonic_time();
                this._onDeleted();
            } else if (!enabled && wasEnabled) {
                // A held backspace deletes an unknown amount of text.
                const heldMs = (GLib.get_monotonic_time() - this._deletePressTime) / 1000;
                if (heldMs > LONG_DELETE_MS)
                    this._buffer = '';
                this._scheduleSuggest(SUGGEST_DELAY_MS);
            }
        };

        ctrl.keyvalPress = keyval => {
            if (this._panel?.capturesTyping && keyval === Clutter.KEY_Return) {
                this._swallowRelease = true;
                this._panel.enter();
                return;
            }
            this._orig.keyvalPress.call(ctrl, keyval);
            if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter)
                this._onTextCommitted('\n');
        };

        ctrl.keyvalRelease = keyval => {
            if (this._swallowRelease && keyval === Clutter.KEY_Return) {
                this._swallowRelease = false;
                return;
            }
            this._orig.keyvalRelease.call(ctrl, keyval);
        };
    }

    _unhookController() {
        const ctrl = this._ctrl;
        if (!ctrl)
            return;
        for (const name of Object.keys(this._orig)) {
            if (Object.prototype.hasOwnProperty.call(ctrl, name))
                delete ctrl[name];
        }
        this._ctrl = null;
    }

    _pressKey(keyval) {
        this._orig.keyvalPress.call(this._ctrl, keyval);
        this._orig.keyvalRelease.call(this._ctrl, keyval);
    }

    // Commit into the focused app regardless of captured typing.
    _commitToApp(str) {
        const promise = this._orig.commit.call(this._ctrl, str, null);
        this._onTextCommitted(str);
        return promise.catch(e => console.error(`NextKeyBor: commit failed: ${e}`));
    }

    _isPassword() {
        const purpose = this._ctrl?.purpose;
        const hints = Main.inputMethod.content_hints ?? 0;
        return purpose === Clutter.InputContentPurpose.PASSWORD ||
            (hints & Clutter.InputContentHintFlags.SENSITIVE_DATA) !== 0;
    }

    _isTerminal() {
        if (this._ctrl?.purpose === Clutter.InputContentPurpose.TERMINAL)
            return true;
        const wmClass = global.display.focus_window?.get_wm_class() ?? '';
        return TERMINAL_WM_CLASS.test(wmClass);
    }

    // ---- text tracking ----------------------------------------------------

    _surroundingFresh() {
        const [text] = Main.inputMethod.getSurroundingText();
        return !!text && !this._isTerminal() &&
            this._lastSurroundingTime >= this._lastCommitTime;
    }

    _context() {
        if (this._surroundingFresh()) {
            const [text, cursor] = Main.inputMethod.getSurroundingText();
            const before = GLib.utf8_substring(text, 0, cursor);
            return before.slice(-MAX_BUFFER);
        }
        return this._buffer;
    }

    _resetText() {
        this._flushLearn();
        this._buffer = '';
        this._lastCommitTime = GLib.get_monotonic_time();
        this._suggestionBox.destroy_all_children();
    }

    _onTextCommitted(str) {
        this._lastCommitTime = GLib.get_monotonic_time();
        this._buffer = (this._buffer + str).slice(-MAX_BUFFER);
        if (!this._isPassword() && this._settings.get_boolean('learn-words')) {
            this._pendingLearn += str;
            const words = this._pendingLearn.trim().split(/\s+/).length;
            if (/[.!?\n]\s*$/.test(this._pendingLearn) ||
                (/\s$/.test(this._pendingLearn) && words >= LEARN_WORD_BATCH))
                this._flushLearn();
        }
        this._scheduleSuggest(SUGGEST_DELAY_MS);
    }

    _onDeleted() {
        this._lastCommitTime = GLib.get_monotonic_time();
        this._buffer = [...this._buffer].slice(0, -1).join('');
        this._pendingLearn = [...this._pendingLearn].slice(0, -1).join('');
        this._scheduleSuggest(SUGGEST_DELAY_MS);
    }

    _flushLearn() {
        const text = this._pendingLearn.trim();
        this._pendingLearn = '';
        if (!text || !this._daemon.available || this._isPassword())
            return;
        this._daemon.learnText(text, '').catch(() => {});
    }

    _scheduleSuggest(delay) {
        if (this._suggestId)
            GLib.source_remove(this._suggestId);
        this._suggestId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._suggestId = 0;
            this._updateSuggestions().catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    async _updateSuggestions() {
        if (!this._suggestionBox.visible || !this._kb?.visible)
            return;
        const serial = ++this._suggestSerial;
        const context = this._context();
        const words = await this._daemon.suggest(context, '', MAX_SUGGESTIONS);
        if (this._destroyed || serial !== this._suggestSerial)
            return;
        this._suggestionBox.destroy_all_children();
        const partial = lastWord(context);
        words.forEach((word, i) => {
            const shown = matchCase(word, partial);
            const button = new St.Button({
                style_class: `nkb-suggestion${i === 0 && partial ? ' nkb-suggestion-best' : ''}`,
                label: shown,
                can_focus: false,
                x_expand: true,
            });
            connectTap(button, {
                onTap: () => this._applySuggestion(shown),
                onLongPress: () => {
                    this._daemon.forgetWord(word).catch(() => {});
                    button.destroy();
                },
            });
            this._suggestionBox.add_child(button);
        });
    }

    _applySuggestion(word) {
        const context = this._context();
        const partial = lastWord(context);
        const len = [...partial].length;
        if (len > 0) {
            if (this._surroundingFresh()) {
                Main.inputMethod.delete_surrounding(-len, len);
            } else {
                for (let i = 0; i < len; i++)
                    this._pressKey(Clutter.KEY_BackSpace);
            }
            this._buffer = [...this._buffer].slice(0, -len).join('');
            this._pendingLearn = [...this._pendingLearn].slice(0, -Math.min(len, [...this._pendingLearn].length)).join('');
        }
        const space = this._settings.get_boolean('auto-space') ? ' ' : '';
        this._commitToApp(word + space);
    }

    // ---- dictation --------------------------------------------------------

    async _toggleDictation() {
        const d = this._dictation;
        try {
            if (d.state === 'idle') {
                d.state = 'starting';
                this._syncMic();
                d.id = await this._daemon.startDictation(this._settings.get_string('speech-language'));
                if (d.state === 'starting')
                    d.state = 'recording';
            } else if (d.state === 'recording') {
                d.state = 'transcribing';
                await this._daemon.stopDictation(d.id);
            } else if (d.state === 'transcribing') {
                await this._daemon.cancelDictation(d.id);
                d.state = 'idle';
                d.id = null;
            }
        } catch (e) {
            d.state = 'idle';
            d.id = null;
            this._flashStatus(`Dictation failed: ${e.message}`);
        }
        this._syncMic();
    }

    _onDictationState(id, state) {
        const d = this._dictation;
        if (d.id && id !== d.id)
            return;
        d.state = state;
        if (state === 'idle')
            d.id = null;
        this._syncMic();
    }

    _onDictationLevel(level) {
        if (this._dictation.state !== 'recording')
            return;
        this._micIcon.opacity = Math.round(110 + 145 * Math.min(1, level * 3));
    }

    _onDictationResult(id, text) {
        const d = this._dictation;
        if (d.id && id !== d.id)
            return;
        d.state = 'idle';
        d.id = null;
        this._syncMic();
        text = text?.trim();
        if (!text)
            return;
        const context = this._context();
        if (context && !/\s$/.test(context))
            text = ` ${text}`;
        if (Main.inputMethod.currentFocus) {
            Main.inputMethod.commit(text);
            this._onTextCommitted(text);
        } else {
            this._commitToApp(text);
        }
    }

    _onDictationError(id, message) {
        const d = this._dictation;
        if (d.id && id !== d.id)
            return;
        d.state = 'idle';
        d.id = null;
        this._syncMic();
        this._flashStatus(message);
    }

    _syncMic() {
        const state = this._dictation.state;
        const active = state === 'recording' || state === 'starting';
        if (active)
            this._micButton.add_style_class_name('nkb-recording');
        else
            this._micButton.remove_style_class_name('nkb-recording');
        if (state === 'transcribing')
            this._micButton.add_style_class_name('nkb-transcribing');
        else
            this._micButton.remove_style_class_name('nkb-transcribing');
        this._micIcon.opacity = 255;
        this._micIcon.icon_name = state === 'transcribing'
            ? 'content-loading-symbolic' : 'audio-input-microphone-symbolic';
        const lang = this._settings.get_string('speech-language');
        if (active)
            this._showToolbarStatus(`Listening${lang === 'auto' ? '' : ` (${lang})`}… tap 🎤 to finish`);
        else if (state === 'transcribing')
            this._showToolbarStatus('Transcribing…');
        else if (!this._flashId)
            this._showToolbarStatus('');
    }

    _flashStatus(text) {
        this._showToolbarStatus(text);
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            this._flashId = 0;
            if (!this._destroyed)
                this._syncMic();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- media ------------------------------------------------------------

    async _pasteMedia(item) {
        let {path, mime} = await this._daemon.prepareMedia(item);
        if (!path)
            [, path, mime] = await waitForSignal(this._daemon, 'MediaReady', item.id, MEDIA_READY_TIMEOUT_MS);
        const bytes = await loadBytes(path);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mime || 'image/gif', bytes);

        // Give the clipboard owner change a moment to reach the client.
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            r();
            return GLib.SOURCE_REMOVE;
        }));
        const ctrl = this._ctrl;
        const press = k => this._orig.keyvalPress.call(ctrl, k);
        const release = k => this._orig.keyvalRelease.call(ctrl, k);
        const shift = this._isTerminal();
        press(Clutter.KEY_Control_L);
        if (shift)
            press(Clutter.KEY_Shift_L);
        press(Clutter.KEY_v);
        release(Clutter.KEY_v);
        if (shift)
            release(Clutter.KEY_Shift_L);
        release(Clutter.KEY_Control_L);
    }
}
