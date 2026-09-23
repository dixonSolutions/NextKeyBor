// Search panels shown above (or instead of) the keys: emoji & symbols, GIFs &
// stickers, and the language menu. While a panel is open the OSK keys type
// into the panel's query instead of the focused app ("captured typing").

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as InputSourceManager from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {AnimatedImage} from './animatedImage.js';
import {connectTap, iconButton, labelButton, setChecked} from './widgets.js';

const SEARCH_DEBOUNCE_MS = 250;
const TOUCH_SCROLL_SLOP = 10;

// Drag-to-scroll for touchscreens: St.ScrollView only scrolls with wheels
// and scrollbars. Children still get their events; connectTap() cancels a tap
// once the finger moved.
function enableTouchScroll(scrollView, horizontal = false) {
    let startCoord = null;
    let startValue = 0;
    let dragging = false;
    const adjustment = () => horizontal
        ? scrollView.hadjustment : scrollView.vadjustment;
    scrollView.connect('captured-event', (_a, event) => {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            startCoord = horizontal ? x : y;
            startValue = adjustment().value;
            dragging = false;
        } else if (type === Clutter.EventType.TOUCH_UPDATE && startCoord !== null) {
            const [x, y] = event.get_coords();
            const delta = (horizontal ? x : y) - startCoord;
            if (!dragging && Math.abs(delta) > TOUCH_SCROLL_SLOP)
                dragging = true;
            if (dragging)
                adjustment().value = startValue - delta;
        } else if (type === Clutter.EventType.TOUCH_END ||
                   type === Clutter.EventType.TOUCH_CANCEL) {
            startCoord = null;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}

function flowBox(styleClass) {
    return new St.Widget({
        style_class: styleClass,
        layout_manager: new Clutter.FlowLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_spacing: 6,
            row_spacing: 6,
        }),
        x_expand: true,
    });
}

const Panel = GObject.registerClass({
    Signals: {
        'close-request': {},
        'expanded-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Panel extends St.BoxLayout {
    _init({placeholder, tabs = [], styleClass = ''}) {
        super._init({
            style_class: `nkb-panel ${styleClass}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.query = '';
        this.expanded = false;
        this._placeholder = placeholder;
        this._searchTimeoutId = 0;

        const header = new St.BoxLayout({style_class: 'nkb-panel-header', x_expand: true});
        this.add_child(header);

        this._tabButtons = new Map();
        for (const {id, label, icon} of tabs) {
            const button = icon
                ? iconButton(icon, {styleClass: 'nkb-tab', accessibleName: label, onTap: () => this.setTab(id)})
                : labelButton(label, {styleClass: 'nkb-tab', onTap: () => this.setTab(id)});
            this._tabButtons.set(id, button);
            header.add_child(button);
        }

        const queryBox = new St.BoxLayout({style_class: 'nkb-query', x_expand: true});
        queryBox.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'nkb-query-icon'}));
        this._queryLabel = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'nkb-query-label',
        });
        this._queryLabel.clutter_text.ellipsize = 1; // Pango.EllipsizeMode.START
        queryBox.add_child(this._queryLabel);
        this._clearButton = iconButton('edit-clear-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Clear',
            onTap: () => this.setQuery(''),
        });
        queryBox.add_child(this._clearButton);
        header.add_child(queryBox);

        this._extraHeader = new St.BoxLayout();
        header.add_child(this._extraHeader);

        this._expandButton = iconButton('view-fullscreen-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Expand',
            onTap: () => this.setExpanded(!this.expanded),
        });
        header.add_child(this._expandButton);
        header.add_child(iconButton('window-close-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Close',
            onTap: () => this.emit('close-request'),
        }));

        this.scrollView = new St.ScrollView({
            style_class: 'nkb-panel-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        enableTouchScroll(this.scrollView);
        this.add_child(this.scrollView);

        this.status = new St.Label({style_class: 'nkb-status', visible: false, x_expand: true});
        this.status.clutter_text.line_wrap = true;

        this.connect('destroy', () => this._cancelSearch());
        this._syncQueryLabel();
    }

    get capturesTyping() {
        return true;
    }

    setExpanded(expanded) {
        if (this.expanded === expanded)
            return;
        this.expanded = expanded;
        this._expandButton.child.icon_name = expanded
            ? 'view-restore-symbolic' : 'view-fullscreen-symbolic';
        this.emit('expanded-changed', expanded);
    }

    setTab(id) {
        this.tab = id;
        for (const [tabId, button] of this._tabButtons)
            setChecked(button, tabId === id);
        this.refresh();
    }

    setQuery(query) {
        if (query === this.query)
            return;
        this.query = query;
        this._syncQueryLabel();
        this._cancelSearch();
        this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._searchTimeoutId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearch() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
    }

    _syncQueryLabel() {
        if (this.query) {
            this._queryLabel.text = this.query;
            this._queryLabel.remove_style_class_name('nkb-placeholder');
        } else {
            this._queryLabel.text = this._placeholder;
            this._queryLabel.add_style_class_name('nkb-placeholder');
        }
        this._clearButton.visible = this.query.length > 0;
    }

    // Captured typing
    typeText(str) {
        if (str === '\n')
            return;
        this.setQuery(this.query + str);
    }

    backspace() {
        if (this.query)
            this.setQuery([...this.query].slice(0, -1).join(''));
    }

    enter() {
        this._cancelSearch();
        this.refresh();
    }

    showStatus(text) {
        this.status.text = text ?? '';
        this.status.visible = !!text;
    }

    refresh() {}
});

// ---------------------------------------------------------------------------

export const EmojiPanel = GObject.registerClass(
class EmojiPanel extends Panel {
    _init(daemon, {commit}) {
        super._init({
            placeholder: 'Search emoji',
            styleClass: 'nkb-emoji-panel',
            tabs: [
                {id: 'emoji', label: 'Emoji', icon: 'face-smile-symbolic'},
                {id: 'symbols', label: 'Ω'},
            ],
        });
        this._daemon = daemon;
        this._commit = commit;
        this._serial = 0;

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        this._grid = flowBox('nkb-emoji-grid');
        box.add_child(this._grid);
        this.scrollView.child = box;
        this.setTab('emoji');
    }

    async refresh() {
        const serial = ++this._serial;
        const symbols = this.tab === 'symbols';
        this._placeholder = symbols ? 'Search symbols (arrow, euro, degree…)' : 'Search emoji';
        this._syncQueryLabel();
        let results;
        try {
            results = symbols
                ? await this._daemon.searchSymbols(this.query, 120)
                : await this._daemon.searchEmoji(this.query, 120);
        } catch (e) {
            if (serial === this._serial)
                this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
            return;
        }
        if (serial !== this._serial)
            return;
        this._grid.destroy_all_children();
        this.showStatus(results.length ? '' : 'Nothing found');
        for (const r of results) {
            const char = symbols ? r.symbol : r.emoji;
            if (!char)
                continue;
            const button = new St.Button({
                style_class: `nkb-emoji ${symbols ? 'nkb-symbol' : ''}`,
                label: char,
                accessible_name: r.name ?? char,
                can_focus: false,
            });
            connectTap(button, {
                onTap: () => {
                    this._commit(char);
                    if (!symbols)
                        this._daemon.noteEmojiUsed(char).catch(() => {});
                },
                onLongPress: () => this.showStatus(`${char}  ${r.name ?? ''}`),
            });
            this._grid.add_child(button);
        }
        this.scrollView.vadjustment.value = 0;
    }
});

// ---------------------------------------------------------------------------

const PAGE_LOAD_MARGIN = 240;

export const MediaPanel = GObject.registerClass(
class MediaPanel extends Panel {
    _init(daemon, settings, {kind, paste, openPreferences}) {
        const gif = kind === 'gif';
        super._init({
            placeholder: gif ? 'Search GIFs' : 'Search stickers',
            styleClass: 'nkb-media-panel',
            tabs: [
                {id: 'online', label: gif ? 'GIFs' : 'Stickers'},
                {id: 'favorites', label: 'Favourites', icon: 'starred-symbolic'},
                {id: 'mine', label: 'Mine', icon: 'user-home-symbolic'},
            ],
        });
        this._daemon = daemon;
        this._settings = settings;
        this._kind = kind;
        this._paste = paste;
        this._openPreferences = openPreferences;
        this._requestId = null;
        this._loading = false;
        this._exhausted = false;
        this._count = 0;
        this._serial = 0;
        this._thumbs = new Map(); // id -> [AnimatedImage]

        this._addButton = iconButton('list-add-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Add your own',
            onTap: () => {
                this.showStatus('Choose files in the dialog…');
                this._daemon.importOwnMedia([], '').catch(e => this.showStatus(e.message));
            },
        });
        this._extraHeader.add_child(this._addButton);

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        this._hint = new St.BoxLayout({style_class: 'nkb-hint', visible: false, x_expand: true});
        const hintLabel = new St.Label({
            text: 'Online search needs a free API key (GIPHY, KLIPY or Tenor). Favourites and your own GIFs work without one.',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        hintLabel.clutter_text.line_wrap = true;
        this._hint.add_child(hintLabel);
        this._hint.add_child(labelButton('Settings', {
            styleClass: 'nkb-pill',
            onTap: () => this._openPreferences(),
        }));
        box.add_child(this._hint);
        this._grid = flowBox('nkb-media-grid');
        box.add_child(this._grid);
        this.scrollView.child = box;

        this.scrollView.vadjustment.connect('notify::value', () => this._maybeLoadMore());

        daemon.connectObject(
            'MediaResults', (_d, requestId, json) => this._onResults(requestId, json),
            'MediaError', (_d, requestId, message) => {
                if (requestId === this._requestId) {
                    this._loading = false;
                    this.showStatus(message);
                }
            },
            'MediaPreviewReady', (_d, id, path) => {
                for (const t of this._thumbs.get(id) ?? [])
                    t.setFile(path);
            },
            'FavoritesChanged', () => {
                if (this.tab === 'favorites')
                    this.refresh();
            },
            'OwnMediaChanged', () => {
                this.showStatus('');
                if (this.tab === 'mine')
                    this.refresh();
            },
            this);
        this._providerState = this._providerKey();
        settings.connectObject('changed', (_s, key) => {
            if (!key.endsWith('api-key') && key !== 'gif-provider')
                return;
            const state = this._providerKey();
            if (state !== this._providerState) {
                this._providerState = state;
                this.refresh();
            }
        }, this);

        this.setTab('online');
    }

    _providerKey() {
        const provider = this._settings.get_string('gif-provider');
        return `${provider}:${this._settings.get_string(`${provider}-api-key`)}`;
    }

    _hasApiKey() {
        const provider = this._settings.get_string('gif-provider');
        return this._settings.get_string(`${provider}-api-key`).length > 0;
    }

    _clear() {
        this._grid.destroy_all_children();
        this._thumbs.clear();
        this._count = 0;
        this._exhausted = false;
        this.scrollView.vadjustment.value = 0;
    }

    async refresh() {
        const serial = ++this._serial;
        this._addButton.visible = this.tab === 'mine';
        this._hint.visible = false;
        this.showStatus('');
        this._requestId = null;
        this._loading = false;

        if (this.tab === 'online') {
            this._clear();
            if (!this._hasApiKey()) {
                this._hint.visible = true;
                return;
            }
            this._loadPage();
            return;
        }

        let items;
        try {
            items = this.tab === 'favorites'
                ? await this._daemon.listFavorites(this._kind, this.query)
                : await this._daemon.listOwnMedia(this.query);
        } catch (e) {
            if (serial === this._serial)
                this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
            return;
        }
        if (serial !== this._serial)
            return;
        this._clear();
        this._exhausted = true;
        if (!items.length) {
            this.showStatus(this.tab === 'favorites'
                ? 'No favourites yet — long-press a GIF to add it.'
                : 'No GIFs of your own yet — tap + to add some.');
        }
        this._addItems(items);
    }

    async _loadPage() {
        if (this._loading || this._exhausted)
            return;
        this._loading = true;
        try {
            this._requestId = await this._daemon.searchMedia(this._kind, this.query, this._count);
        } catch (e) {
            this._loading = false;
            this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
        }
    }

    _onResults(requestId, json) {
        if (requestId !== this._requestId || this.tab !== 'online')
            return;
        this._loading = false;
        let items = [];
        try {
            items = JSON.parse(json);
        } catch {}
        if (!items.length) {
            this._exhausted = true;
            if (this._count === 0)
                this.showStatus('Nothing found');
            return;
        }
        this._addItems(items);
        // Fill the view if the first page was not enough to scroll.
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._maybeLoadMore();
            return GLib.SOURCE_REMOVE;
        });
    }

    _maybeLoadMore() {
        if (this.tab !== 'online' || this._loading || this._exhausted)
            return;
        const adj = this.scrollView.vadjustment;
        if (adj.value + adj.page_size >= adj.upper - PAGE_LOAD_MARGIN)
            this._loadPage();
    }

    _addItems(items) {
        const height = this.expanded ? 120 : 88;
        for (const item of items) {
            this._count++;
            const cell = new St.Widget({
                style_class: 'nkb-media-cell',
                layout_manager: new Clutter.BinLayout(),
                accessible_name: item.title ?? '',
            });
            const image = new AnimatedImage({height});
            cell.add_child(image);
            if (item.preview)
                image.setFile(item.preview);
            const list = this._thumbs.get(item.id) ?? [];
            list.push(image);
            this._thumbs.set(item.id, list);

            const star = new St.Icon({
                icon_name: 'starred-symbolic',
                style_class: 'nkb-fav-badge',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                visible: !!item.favorite,
            });
            cell.add_child(star);

            connectTap(cell, {
                onTap: () => this._activate(item),
                onLongPress: () => {
                    item.favorite = !item.favorite;
                    star.visible = item.favorite;
                    this._daemon.setFavorite(item, item.favorite).catch(e => this.showStatus(e.message));
                    this.showStatus(item.favorite ? 'Added to favourites' : 'Removed from favourites');
                },
            });
            this._grid.add_child(cell);
        }
    }

    async _activate(item) {
        this.showStatus('Inserting…');
        try {
            await this._paste(item);
            this.showStatus('');
        } catch (e) {
            this.showStatus(`Could not insert: ${e.message}`);
        }
    }
});

// ---------------------------------------------------------------------------

export const LanguagePanel = GObject.registerClass(
class LanguagePanel extends Panel {
    _init(daemon, settings) {
        super._init({
            placeholder: 'Search languages',
            styleClass: 'nkb-language-panel',
            tabs: [
                {id: 'speech', label: 'Dictation', icon: 'audio-input-microphone-symbolic'},
                {id: 'layouts', label: 'Layouts', icon: 'input-keyboard-symbolic'},
                {id: 'download', label: 'Download', icon: 'folder-download-symbolic'},
            ],
        });
        this._daemon = daemon;
        this._settings = settings;
        this._serial = 0;
        this._progress = new Map(); // "lang:pl_PL" -> St.Label

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        this._list = new St.BoxLayout({
            style_class: 'nkb-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(this._list);
        this.scrollView.child = box;

        daemon.connectObject(
            'DownloadProgress', (_d, what, fraction) => {
                const label = this._progress.get(what);
                if (label)
                    label.text = `${Math.round(fraction * 100)} %`;
            },
            'DownloadFinished', (_d, what, success, message) => {
                const label = this._progress.get(what);
                if (label)
                    label.text = success ? 'Installed' : 'Failed';
                if (!success && message)
                    this.showStatus(message);
                if (success)
                    this.refresh();
            }, this);

        this.setTab('speech');
    }

    _row(title, subtitle, {checked = false, action = null, onTap = null, progressKey = null} = {}) {
        const row = new St.BoxLayout({style_class: 'nkb-row', x_expand: true, reactive: true});
        if (checked)
            row.add_style_pseudo_class('checked');
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({text: title, style_class: 'nkb-row-title'}));
        if (subtitle)
            text.add_child(new St.Label({text: subtitle, style_class: 'nkb-row-subtitle'}));
        row.add_child(text);
        if (checked)
            row.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'nkb-row-icon'}));
        if (action) {
            const label = new St.Label({style_class: 'nkb-row-progress', y_align: Clutter.ActorAlign.CENTER});
            if (progressKey)
                this._progress.set(progressKey, label);
            row.add_child(label);
            row.add_child(labelButton(action.label, {
                styleClass: 'nkb-pill',
                onTap: () => {
                    label.text = '…';
                    action.run().catch(e => {
                        label.text = '';
                        this.showStatus(e.message);
                    });
                },
            }));
        }
        if (onTap)
            connectTap(row, {onTap});
        this._list.add_child(row);
        return row;
    }

    _header(text) {
        this._list.add_child(new St.Label({text, style_class: 'nkb-list-header'}));
    }

    _matches(...fields) {
        const q = this.query.trim().toLowerCase();
        return !q || fields.some(f => f?.toLowerCase().includes(q));
    }

    async refresh() {
        const serial = ++this._serial;
        this.showStatus('');
        try {
            if (this.tab === 'speech')
                await this._fillSpeech(serial);
            else if (this.tab === 'layouts')
                this._fillLayouts();
            else
                await this._fillDownloads(serial);
        } catch (e) {
            if (serial === this._serial)
                this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
        }
    }

    _reset() {
        this._list.destroy_all_children();
        this._progress.clear();
        this.scrollView.vadjustment.value = 0;
    }

    async _fillSpeech(serial) {
        const languages = await this._daemon.listSpeechLanguages();
        if (serial !== this._serial)
            return;
        this._reset();
        const current = this._settings.get_string('speech-language');
        const recent = this._settings.get_strv('speech-recent-languages');
        const byCode = new Map(languages.map(l => [l.code, l]));
        const pick = code => {
            this._settings.set_string('speech-language', code);
            const updated = [code, ...recent.filter(c => c !== code)].slice(0, 6);
            this._settings.set_strv('speech-recent-languages', updated);
            this.emit('close-request');
        };
        const add = lang => this._row(lang.name, lang.code === 'auto' ? 'Detect automatically' : lang.code, {
            checked: lang.code === current,
            onTap: () => pick(lang.code),
        });

        const recentLangs = recent.map(c => byCode.get(c) ?? (c === 'auto' ? {code: 'auto', name: 'Automatic'} : null))
            .filter(l => l && this._matches(l.name, l.code));
        if (recentLangs.length) {
            this._header('Recent');
            recentLangs.forEach(add);
        }
        const rest = languages.filter(l => !recent.includes(l.code) && this._matches(l.name, l.code));
        if (rest.length) {
            this._header('All dictation languages');
            rest.forEach(add);
        }
        if (!recentLangs.length && !rest.length)
            this.showStatus('No matching language');
    }

    _fillLayouts() {
        this._reset();
        const manager = InputSourceManager.getInputSourceManager();
        const current = manager.currentSource;
        const sources = Object.values(manager.inputSources ?? {});
        this._header('Keyboard layouts (system input sources)');
        for (const source of sources) {
            if (!this._matches(source.displayName, source.shortName, source.id))
                continue;
            this._row(source.displayName, source.id, {
                checked: source === current,
                onTap: () => {
                    source.activate(true);
                    this.emit('close-request');
                },
            });
        }
        this.showStatus(sources.length > 1 ? '' : 'Add more layouts in the Download tab or in Settings → Keyboard.');
    }

    async _fillDownloads(serial) {
        const [languages, models] = await Promise.all([
            this._daemon.listLanguages(),
            this._daemon.listSpeechModels(),
        ]);
        if (serial !== this._serial)
            return;
        this._reset();
        const active = this._settings.get_string('active-language');

        this._header('Typing languages (dictionary + keyboard layout)');
        for (const lang of languages) {
            if (!this._matches(lang.name, lang.code))
                continue;
            const installed = lang.dictionary && (!lang.layout || lang.layout_enabled);
            const subtitle = [
                lang.code,
                lang.dictionary ? 'dictionary ✓' : 'no dictionary',
                lang.layout ? (lang.layout_enabled ? `layout ${lang.layout} ✓` : `layout ${lang.layout}`) : null,
            ].filter(Boolean).join(' · ');
            this._row(lang.name, subtitle, {
                checked: lang.code === active,
                onTap: lang.dictionary ? () => {
                    this._settings.set_string('active-language', lang.code);
                    this._daemon.setActiveLanguage(lang.code).catch(() => {});
                    this.refresh();
                } : null,
                action: installed ? null : {
                    label: 'Install',
                    run: () => this._daemon.installLanguage(lang.code),
                },
                progressKey: `lang:${lang.code}`,
            });
        }

        this._header('Speech models (whisper.cpp)');
        for (const model of models) {
            if (!this._matches(model.name))
                continue;
            const subtitle = `${model.size_mb} MB · ${model.multilingual ? 'multilingual' : 'English only'}`;
            this._row(model.name, subtitle, {
                checked: !!model.active,
                onTap: model.installed ? () => {
                    this._settings.set_string('speech-model', model.name);
                    this.refresh();
                } : null,
                action: model.installed ? null : {
                    label: 'Download',
                    run: () => this._daemon.downloadSpeechModel(model.name),
                },
                progressKey: `model:${model.name}`,
            });
        }
    }
});
