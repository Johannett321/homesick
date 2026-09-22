// Emoji — a macOS-style emoji picker for GNOME Shell (Ctrl+Space).
//
// Opens next to the text cursor, searches by name and keyword, and types the
// chosen emoji into the focused app through GNOME's input method (the same
// path the on-screen keyboard uses), so the clipboard is left alone. Apps
// without input-method support get it pasted via the clipboard instead.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

// ---- Tweakables -------------------------------------------------------------
const SHORTCUT = '<Control>space';
const COLUMNS = 9;
const RECENT_MAX = 18;
const CLDR_ANNOTATIONS = '/usr/share/unicode/cldr/common/annotations/en.xml';
// -----------------------------------------------------------------------------

// First emoji name of each category, as in GNOME's on-screen keyboard.
const CATEGORIES = [
    {first: 'grinning face', icon: '😀', title: 'Smileys & Emotion'},
    {first: 'selfie', icon: '👋', title: 'People & Body'},
    {first: 'monkey face', icon: '🐻', title: 'Animals & Nature'},
    {first: 'grapes', icon: '🍔', title: 'Food & Drink'},
    {first: 'globe showing Europe-Africa', icon: '✈️', title: 'Travel & Places'},
    {first: 'jack-o-lantern', icon: '⚽', title: 'Activities'},
    {first: 'muted speaker', icon: '💡', title: 'Objects'},
    {first: 'ATM sign', icon: '🔣', title: 'Symbols'},
    {first: 'chequered flag', icon: '🏳️', title: 'Flags'},
];

// Single code points that render as text unless followed by U+FE0F.
function withPresentation(ch) {
    const cps = [...ch];
    if (cps.length === 1 && cps[0].codePointAt(0) < 0x1F000)
        return `${ch}️`;
    return ch;
}

function loadEmoji() {
    const file = Gio.File.new_for_uri('resource:///org/gnome/shell/osk-layouts/emoji.json');
    const [, contents] = file.load_contents(null);
    const list = JSON.parse(new TextDecoder().decode(contents));

    const keywords = new Map();
    try {
        const [, xml] = GLib.file_get_contents(CLDR_ANNOTATIONS);
        const text = new TextDecoder().decode(xml);
        for (const m of text.matchAll(/<annotation cp="([^"]+)">([^<]+)<\/annotation>/g))
            keywords.set(m[1].replace(/️/g, ''), m[2].split('|').map(k => k.trim().toLowerCase()));
    } catch (e) {
        // Keywords are optional; search still works on names.
    }

    const categories = CATEGORIES.map(c => ({...c, emoji: []}));
    let current = null;
    for (const e of list) {
        const cat = categories.find(c => c.first === e.name);
        if (cat)
            current = cat;
        if (!current || /skin tone/.test(e.name))
            continue;
        const char = withPresentation(e.char);
        current.emoji.push({
            char,
            name: e.name,
            words: keywords.get(e.char.replace(/️/g, '')) ?? [],
        });
    }
    return categories;
}

function score(emoji, query) {
    const name = emoji.name.toLowerCase();
    if (name === query)
        return 100;
    if (emoji.words.includes(query))
        return 95;
    if (name.startsWith(query))
        return 90;
    if (name.split(/[\s:-]+/).some(w => w.startsWith(query)))
        return 75;
    if (emoji.words.some(w => w.startsWith(query)))
        return 65;
    if (name.includes(query))
        return 50;
    if (emoji.words.some(w => w.includes(query)))
        return 40;
    return 0;
}

class Recent {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'homesick-emoji']);
        this._path = GLib.build_filenamev([this._dir, 'recent.json']);
        try {
            this.list = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(this._path)[1]));
        } catch (e) {
            this.list = [];
        }
    }

    add(char) {
        this.list = [char, ...this.list.filter(c => c !== char)].slice(0, RECENT_MAX);
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this._path, JSON.stringify(this.list));
        } catch (e) {
            console.warn(`Emoji: can't save recent emoji: ${e.message}`);
        }
    }
}

class EmojiPicker {
    constructor() {
        this._recent = new Recent();
        this._categories = null;
        this._buttons = [];     // visible emoji buttons, in order
        this._selected = -1;
        this._isOpen = false;
        this._grab = null;
        this._cursorRect = null;
        this._target = null;

        this._container = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        this._container.connect('button-press-event', (a, event) => {
            const [x, y] = event.get_coords();
            const [px, py] = this._panel.get_transformed_position();
            const [pw, ph] = this._panel.get_transformed_size();
            if (x < px || x > px + pw || y < py || y > py + ph)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this._panel = new St.BoxLayout({style_class: 'emoji-panel', orientation: Clutter.Orientation.VERTICAL});
        this._container.add_child(this._panel);

        this._entry = new St.Entry({
            style_class: 'emoji-search',
            hint_text: 'Search',
            can_focus: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'emoji-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => this._filter());
        this._entry.clutter_text.connect('key-press-event', (a, event) => this._onKey(event));
        this._panel.add_child(this._entry);

        this._content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'emoji-content'});
        this._scroll = new St.ScrollView({
            style_class: 'emoji-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._content,
        });
        this._panel.add_child(this._scroll);

        this._nameLabel = new St.Label({style_class: 'emoji-name', text: ' '});
        this._panel.add_child(this._nameLabel);

        this._tabs = new St.BoxLayout({style_class: 'emoji-tabs'});
        this._panel.add_child(this._tabs);

        // Where is the text cursor? Clutter tells us for Wayland text inputs.
        // Remember it relative to its window, since apps only report it when it moves.
        Main.inputMethod.connectObject('cursor-location-changed', (im, rect) => {
            const win = global.display.focus_window;
            const frame = win?.get_frame_rect();
            this._cursorRect = {
                win,
                dx: rect.get_x() - (frame?.x ?? 0), dy: rect.get_y() - (frame?.y ?? 0),
                width: rect.get_width(), height: rect.get_height(),
            };
        }, this);

        Main.layoutManager.addTopChrome(this._container);

        this._built = false;
        this._steps = this._buildSteps();
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._built)
                return GLib.SOURCE_REMOVE;
            this._steps.next();
            if (!this._built)
                return GLib.SOURCE_CONTINUE;
            this._idleId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- building ---------------------------------------------------------

    // Building ~1900 buttons takes a moment, so do it in small steps while
    // idle after login; open() finishes whatever is left.
    _build() {
        while (!this._built)
            this._steps.next();
    }

    *_buildSteps() {
        this._categories = loadEmoji();
        this._recentSection = this._makeSection('Frequently Used');
        yield;
        for (const cat of this._categories) {
            cat.section = this._makeSection(cat.title);
            for (let i = 0; i < cat.emoji.length; i += 120) {
                for (const e of cat.emoji.slice(i, i + 120))
                    cat.section.grid.add_child(this._makeButton(e));
                yield;
            }
        }
        this._searchSection = this._makeSection('Search Results');
        this._searchSection.box.hide();

        const tab = (icon, title, section) => {
            const b = new St.Button({style_class: 'emoji-tab', label: icon, can_focus: false, accessible_name: title});
            b.connect('clicked', () => {
                this._entry.text = '';
                this._scroll.vadjustment.value = section.box.get_allocation_box().y1;
                this._entry.grab_key_focus();
            });
            this._tabs.add_child(b);
        };
        tab('🕘', 'Frequently Used', this._recentSection);
        for (const cat of this._categories)
            tab(cat.icon, cat.title, cat.section);
        yield;
        // Style and lay out every emoji now (St only styles mapped actors), so
        // the first open is instant too. Shown and hidden again before any
        // frame is drawn, so nothing flashes on screen.
        if (!this._isOpen) {
            this._container.opacity = 0;
            this._container.show();
            this._panel.get_preferred_size();
            this._container.hide();
            this._container.opacity = 255;
        }
        this._built = true;
    }

    _makeSection(title) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'emoji-section'});
        box.add_child(new St.Label({text: title, style_class: 'emoji-section-title'}));
        const layout = new Clutter.GridLayout({column_spacing: 1, row_spacing: 1});
        const grid = new St.Widget({layout_manager: layout, style_class: 'emoji-grid', x_align: Clutter.ActorAlign.START});
        grid._count = 0;
        grid.add_child = function (child) {
            layout.attach(child, this._count % COLUMNS, Math.floor(this._count / COLUMNS), 1, 1);
            this._count++;
        };
        grid.clear = function () {
            this.destroy_all_children();
            this._count = 0;
        };
        box.add_child(grid);
        this._content.add_child(box);
        return {box, grid};
    }

    _makeButton(emoji) {
        const button = new St.Button({style_class: 'emoji-button', label: emoji.char, can_focus: false});
        button._emoji = emoji;
        button.connect('clicked', () => this._choose(emoji));
        button.connect('notify::hover', () => {
            if (button.hover)
                this._select(this._buttons.indexOf(button), false);
        });
        return button;
    }

    _refreshRecent() {
        const {grid, box} = this._recentSection;
        grid.clear();
        const all = new Map();
        for (const cat of this._categories)
            for (const e of cat.emoji)
                all.set(e.char, e);
        for (const char of this._recent.list) {
            const e = all.get(char) ?? {char, name: '', words: []};
            grid.add_child(this._makeButton(e));
        }
        box.visible = this._recent.list.length > 0;
    }

    _filter() {
        const query = this._entry.text.trim().toLowerCase();
        const searching = query.length > 0;
        this._recentSection.box.visible = !searching && this._recent.list.length > 0;
        for (const cat of this._categories)
            cat.section.box.visible = !searching;
        this._searchSection.box.visible = searching;
        this._tabs.opacity = searching ? 120 : 255;

        if (searching) {
            const {grid} = this._searchSection;
            grid.clear();
            const results = [];
            for (const cat of this._categories) {
                for (const e of cat.emoji) {
                    const s = score(e, query);
                    if (s > 0)
                        results.push([s, e]);
                }
            }
            results.sort((a, b) => b[0] - a[0]);
            for (const [, e] of results.slice(0, COLUMNS * 12))
                grid.add_child(this._makeButton(e));
            this._searchSection.box.get_first_child().text = results.length ? 'Search Results' : 'No Emoji Found';
            this._scroll.vadjustment.value = 0;
        }
        this._collectButtons();
        this._select(searching && this._buttons.length ? 0 : -1);
    }

    _collectButtons() {
        this._buttons = [];
        for (const section of this._content.get_children()) {
            if (!section.visible)
                continue;
            const grid = section.get_last_child();
            this._buttons.push(...grid.get_children());
        }
    }

    _select(index, scroll = true) {
        this._buttons[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = index;
        const b = this._buttons[index];
        if (!b) {
            this._nameLabel.text = ' ';
            return;
        }
        b.add_style_pseudo_class('selected');
        const name = b._emoji.name;
        this._nameLabel.text = name ? name[0].toUpperCase() + name.slice(1) : ' ';
        if (scroll)
            ensureActorVisibleInScrollView(this._scroll, b);
    }

    // ---- open / close -------------------------------------------------------

    toggle() {
        // Ctrl+Space can arrive through both our key handler and the global
        // shortcut; ignore a second toggle straight after the first.
        const now = GLib.get_monotonic_time();
        if (now - (this._toggledAt ?? 0) < 300000)
            return;
        if (this._isOpen)
            this.close();
        else
            this.open();
        this._toggledAt = GLib.get_monotonic_time();
    }

    open() {
        if (this._isOpen)
            return;
        this._build();
        this._refreshRecent();

        // Remember which window we're typing into, and where its cursor is.
        this._target = global.display.focus_window;
        let cursor = null;
        const c = this._cursorRect;
        if (Main.inputMethod.currentFocus && c && c.win === this._target) {
            const frame = this._target.get_frame_rect();
            cursor = {x: frame.x + c.dx, y: frame.y + c.dy, width: c.width, height: c.height};
        }

        this._container.set_position(0, 0);
        this._container.set_size(global.stage.width, global.stage.height);
        this._container.show();
        this._isOpen = true;
        try {
            this._grab = Main.pushModal(this._container, {actionMode: Shell.ActionMode.POPUP});
        } catch (e) {
            console.error(`Emoji: ${e.message}`);
            this.close();
            return;
        }
        this._entry.text = '';
        this._filter();
        this._scroll.vadjustment.value = 0;
        this._entry.grab_key_focus();
        this._position(cursor);

        this._panel.opacity = 0;
        this._panel.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _position(cursor) {
        const [, , width, height] = this._panel.get_preferred_size();
        let monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        let x, y;
        if (cursor && cursor.width + cursor.height > 0) {
            const idx = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({x: cursor.x, y: cursor.y, width: 1, height: 1}));
            monitor = Main.layoutManager.monitors[idx] ?? monitor;
            x = cursor.x - 20;
            y = cursor.y + cursor.height + 6;
            if (y + height > monitor.y + monitor.height - 8)
                y = cursor.y - height - 6; // no room below: open above the cursor
        } else {
            const [px, py] = global.get_pointer();
            x = px - width / 2;
            y = py - height / 2;
        }
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - width - 8));
        y = Math.max(monitor.y + 8, Math.min(y, monitor.y + monitor.height - height - 8));
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    close() {
        // Always release the screen, whatever else happens.
        this._isOpen = false;
        if (this._grab) {
            const grab = this._grab;
            this._grab = null;
            try {
                Main.popModal(grab);
            } catch (e) {
                console.error(`Emoji: ${e.message}`);
            }
        }
        this._panel.remove_all_transitions();
        this._container.hide();
    }

    // ---- choosing -----------------------------------------------------------

    _choose(emoji) {
        const target = this._target;
        this.close();
        this._recent.add(emoji.char);
        this._insert(emoji.char, target);
    }

    // Once the app has its keyboard focus back, commit the emoji through the
    // input method. Fall back to paste for apps without input-method support.
    _insert(text, target) {
        target?.activate(global.get_current_time());
        let tries = 0;
        this._insertId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (Main.inputMethod.currentFocus) {
                Main.inputMethod.commit(text);
                this._insertId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (++tries < 25)
                return GLib.SOURCE_CONTINUE;
            this._paste(text);
            this._insertId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _paste(text) {
        const clipboard = St.Clipboard.get_default();
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (cb, previous) => {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            const seat = Clutter.get_default_backend().get_default_seat();
            const kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const t = GLib.get_monotonic_time();
            kbd.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            kbd.notify_keyval(t + 1, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            kbd.notify_keyval(t + 2, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            kbd.notify_keyval(t + 3, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
            // Give the app a moment to paste, then put the old clipboard back.
            this._restoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                if (previous !== null)
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
                this._restoreId = 0;
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // ---- keyboard -----------------------------------------------------------

    _onKey(event) {
        const key = event.get_key_symbol();
        const state = event.get_state();
        const move = delta => {
            if (!this._buttons.length)
                return Clutter.EVENT_STOP;
            const next = this._selected < 0 ? 0 : Math.max(0, Math.min(this._buttons.length - 1, this._selected + delta));
            this._select(next);
            return Clutter.EVENT_STOP;
        };
        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_space:
            if (state & Clutter.ModifierType.CONTROL_MASK) {
                this.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: {
            const b = this._buttons[this._selected] ?? this._buttons[0];
            if (b)
                this._choose(b._emoji);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Right:
            return this._entry.text && this._selected < 0 ? Clutter.EVENT_PROPAGATE : move(1);
        case Clutter.KEY_Left:
            return this._entry.text && this._selected < 0 ? Clutter.EVENT_PROPAGATE : move(-1);
        case Clutter.KEY_Down:
            return move(this._selected < 0 ? 0 : COLUMNS);
        case Clutter.KEY_Up:
            return move(-COLUMNS);
        case Clutter.KEY_Tab:
            return move(1);
        case Clutter.KEY_ISO_Left_Tab:
            return move(-1);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this.close();
        if (this._idleId)
            GLib.source_remove(this._idleId);
        if (this._insertId)
            GLib.source_remove(this._insertId);
        if (this._restoreId)
            GLib.source_remove(this._restoreId);
        Main.inputMethod.disconnectObject(this);
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }
}

export default class EmojiExtension extends Extension {
    enable() {
        this._picker = new EmojiPicker();
        this._action = global.display.grab_accelerator(SHORTCUT, Meta.KeyBindingFlags.NONE);
        if (this._action === Meta.KeyBindingAction.NONE) {
            console.warn(`Emoji: could not grab ${SHORTCUT} — is something else using it?`);
            return;
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._action),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
        this._acceleratorId = global.display.connect('accelerator-activated', (display, action) => {
            if (action === this._action)
                this._picker.toggle();
        });
    }

    disable() {
        if (this._acceleratorId) {
            global.display.disconnect(this._acceleratorId);
            this._acceleratorId = 0;
        }
        if (this._action && this._action !== Meta.KeyBindingAction.NONE) {
            global.display.ungrab_accelerator(this._action);
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._action), Shell.ActionMode.NONE);
        }
        this._action = 0;
        this._picker?.destroy();
        this._picker = null;
    }
}
