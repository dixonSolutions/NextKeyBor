import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'io.github.nextkeybor.Daemon';
const OBJECT_PATH = '/io/github/nextkeybor/Daemon';

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3', 'tiny.en', 'base.en', 'small.en'];
const PROVIDERS = [['openverse', 'Openverse (no key)'], ['giphy', 'GIPHY'], ['klipy', 'KLIPY'], ['tenor', 'Tenor']];
const RATINGS = [['g', 'G'], ['pg', 'PG'], ['pg-13', 'PG-13'], ['r', 'R']];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings, key, title, password = false) {
    const row = password
        ? new Adw.PasswordEntryRow({title})
        : new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, choices, subtitle = '') {
    const model = new Gtk.StringList();
    let values = choices.map(c => (Array.isArray(c) ? c[0] : c));
    const current = settings.get_string(key);
    if (!values.includes(current)) {
        choices = [...choices, current];
        values = [...values, current];
    }
    for (const c of choices)
        model.append(Array.isArray(c) ? c[1] : c);
    const row = new Adw.ComboRow({title, subtitle, model});
    row.selected = Math.max(0, values.indexOf(current));
    row.connect('notify::selected', () => {
        const v = values[row.selected];
        if (v !== undefined && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    return row;
}

function spinRow(settings, key, title, lower, upper, subtitle = '') {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function callDaemon(method, params = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method, params, null,
            Gio.DBusCallFlags.NONE, 3000, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export default class NextKeyBorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);

        // --- General / status
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'input-keyboard-symbolic'});
        window.add(general);

        const statusGroup = new Adw.PreferencesGroup({title: 'Daemon'});
        const statusRow = new Adw.ActionRow({title: 'nextkeybord', subtitle: 'Checking…'});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER});
        refresh.add_css_class('flat');
        statusRow.add_suffix(refresh);
        statusGroup.add(statusRow);
        const kbRow = new Adw.ActionRow({title: 'Physical keyboards', subtitle: '—'});
        statusGroup.add(kbRow);
        general.add(statusGroup);

        const updateStatus = async () => {
            try {
                const [json] = await callDaemon('GetStatus');
                const s = JSON.parse(json);
                const speech = s.speech ?? {};
                statusRow.subtitle = [
                    `Running · v${s.version ?? '?'}`,
                    `speech model ${speech.model ?? '?'}${speech.model_ready ? '' : ' (not downloaded)'}`,
                    `GIFs: ${s.gif_provider ?? '?'}`,
                ].join(' · ');
                const k = s.keyboard ?? {};
                kbRow.subtitle = [
                    k.physical?.length ? k.physical.join(', ') : 'none',
                    k.tablet_mode ? 'tablet mode' : null,
                    `OSK ${k.osk_enabled ? 'on' : 'off'}`,
                ].filter(Boolean).join(' · ');
            } catch (e) {
                statusRow.subtitle = `Not running: ${e.message}. Start it with: systemctl --user start nextkeybord`;
                kbRow.subtitle = '—';
            }
        };
        refresh.connect('clicked', () => updateStatus());
        updateStatus();

        const fixes = new Adw.PreferencesGroup({title: 'On-screen keyboard fixes'});
        fixes.add(switchRow(settings, 'disable-bounce-keys', 'Keep Bounce Keys off',
            'GNOME\u2019s Bounce Keys drops quick repeated keys, such as Backspace taps'));
        fixes.add(switchRow(settings, 'chromium-tap-fix', 'Open in Chromium, Electron and Qt apps',
            'Show the keyboard when tapping text fields that GNOME misses'));
        fixes.add(switchRow(settings, 'fix-auto-capitalization', 'Fix random capital letters',
            'Stop Shift latching after backspace in terminals and browsers'));
        general.add(fixes);

        const auto = new Adw.PreferencesGroup({
            title: 'Physical keyboard detection',
            description: 'System-wide: the daemon watches all input devices and the tablet-mode switch.',
        });
        auto.add(switchRow(settings, 'auto-toggle-osk', 'Automatic on-screen keyboard',
            'Enable it only when no physical keyboard is usable'));
        auto.add(switchRow(settings, 'hide-osk-on-typing', 'Hide when typing on a physical keyboard'));
        auto.add(switchRow(settings, 'notify-keyboard-changes', 'Notify on changes'));
        general.add(auto);

        // --- Typing
        const typing = new Adw.PreferencesPage({title: 'Typing', icon_name: 'format-text-plain-symbolic'});
        window.add(typing);
        const sugg = new Adw.PreferencesGroup({title: 'Suggestions'});
        sugg.add(switchRow(settings, 'suggestions-enabled', 'Word suggestions'));
        sugg.add(switchRow(settings, 'auto-space', 'Add a space after a suggestion'));
        sugg.add(switchRow(settings, 'learn-words', 'Learn new words', 'Stored only on this computer; never in password fields'));
        sugg.add(entryRow(settings, 'active-language', 'Dictionary language (e.g. en_US, pl_PL)'));
        typing.add(sugg);
        const holds = new Adw.PreferencesGroup({title: 'Keys'});
        holds.add(switchRow(settings, 'hold-for-numbers', 'Hold for numbers and symbols',
            'Long-press the top row for digits, other letters for symbols'));
        holds.add(switchRow(settings, 'swipe-typing', 'Swipe typing',
            'Slide across the letters to type a word; lift to finish'));
        holds.add(spinRow(settings, 'height-landscape', 'Height in landscape', 15, 60,
            'Percent of the screen; you can also drag the handle on top of the keyboard'));
        holds.add(spinRow(settings, 'height-portrait', 'Height in portrait', 15, 60,
            'Percent of the screen'));
        typing.add(holds);

        // --- Dictation
        const speech = new Adw.PreferencesPage({title: 'Dictation', icon_name: 'audio-input-microphone-symbolic'});
        window.add(speech);
        const sp = new Adw.PreferencesGroup({
            title: 'Speech to text',
            description: 'Runs locally with whisper.cpp. Long-press the microphone key to pick a language.',
        });
        sp.add(entryRow(settings, 'speech-language', 'Language (auto, en, pl, de, …)'));
        sp.add(comboRow(settings, 'speech-model', 'Model', MODELS,
            'Bigger is more accurate but slower. Download models from the keyboard’s language panel.'));
        sp.add(spinRow(settings, 'speech-threads', 'Threads', 0, 64, '0 = automatic'));
        sp.add(spinRow(settings, 'speech-max-seconds', 'Maximum length (seconds)', 5, 600));
        sp.add(switchRow(settings, 'speech-silence-stop', 'Stop after a pause'));
        speech.add(sp);

        // --- GIFs
        const gifs = new Adw.PreferencesPage({title: 'GIFs', icon_name: 'image-x-generic-symbolic'});
        window.add(gifs);
        const prov = new Adw.PreferencesGroup({
            title: 'Online GIFs and stickers',
            description: 'Openverse works without a key but has few reaction GIFs. For GIPHY or KLIPY, get a free key at developers.giphy.com or partner.klipy.com; until a key is set, searches use Openverse. Favourites and your own GIFs work offline.',
        });
        prov.add(comboRow(settings, 'gif-provider', 'Provider', PROVIDERS));
        prov.add(entryRow(settings, 'giphy-api-key', 'GIPHY API key', true));
        prov.add(entryRow(settings, 'klipy-api-key', 'KLIPY API key', true));
        prov.add(entryRow(settings, 'tenor-api-key', 'Tenor API key', true));
        prov.add(comboRow(settings, 'gif-content-rating', 'Content rating', RATINGS));
        prov.add(spinRow(settings, 'gif-cache-mb', 'Cache size (MB)', 20, 5000));
        gifs.add(prov);

        const own = new Adw.PreferencesGroup({title: 'Your library'});
        const importRow = new Adw.ActionRow({
            title: 'Add your own GIFs and stickers',
            subtitle: 'Also available from the + button in the keyboard’s GIF panel',
        });
        const importButton = new Gtk.Button({label: 'Add…', valign: Gtk.Align.CENTER});
        importButton.connect('clicked', () => {
            callDaemon('ImportOwnMedia', new GLib.Variant('(ass)', [[], ''])).catch(e => {
                importRow.subtitle = `Daemon not running: ${e.message}`;
            });
        });
        importRow.add_suffix(importButton);
        own.add(importRow);
        gifs.add(own);
    }
}
