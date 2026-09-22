// Mac Dock — an always-visible, macOS-style dock for GNOME Shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

// ---- Tweakables -------------------------------------------------------------
const ICON_SIZE = 48;          // icon size at rest (logical px)
const MAGNIFICATION = 1.75;    // zoom of the icon under the pointer (1 = off)
const MAG_RANGE = 2.8;         // width of the zoom wave, in icons
const ICON_GAP = 6;            // horizontal space between icons
const SEPARATOR_WIDTH = 15;
const DOT_SPACE = 7;           // room under icons for the running dot
const DOT_SIZE = 4;
const SHOW_LAUNCHPAD = true;
const SHOW_TRASH = true;
// -----------------------------------------------------------------------------

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

class DockItem {
    constructor(dock, iconActor, labelText, {magnify = true} = {}) {
        this.dock = dock;
        this.magnify = magnify;
        this.labelText = labelText;
        this.scale = 1;
        this._destroyed = false;

        const sf = scaleFactor();
        this.basePx = ICON_SIZE * sf;
        this.gapPx = ICON_GAP * sf;
        this.maxPx = Math.round(ICON_SIZE * MAGNIFICATION) * sf;
        this.height = (ICON_SIZE + DOT_SPACE) * sf;

        this.actor = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            track_hover: true,
        });

        this.icon = iconActor;
        this.icon.reactive = true;
        this.icon.set_size(this.maxPx, this.maxPx);
        this.icon.set_pivot_point(0.5, 1);
        this.actor.add_child(this.icon);

        this.dot = new St.Widget({style_class: 'macdock-dot', visible: false});
        this.dot.set_size(DOT_SIZE * sf, DOT_SIZE * sf);
        this.actor.add_child(this.dot);

        this.actor.connect('notify::hover', () => this.dock.onItemHover(this));
        this.actor.connect('button-press-event', (a, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_SECONDARY) {
                this.openMenu();
                return Clutter.EVENT_STOP;
            }
            this._pressed = true;
            this.icon.opacity = 170;
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('button-release-event', (a, event) => {
            if (!this._pressed)
                return Clutter.EVENT_PROPAGATE;
            this._pressed = false;
            this.icon.opacity = 255;
            this.dock.hideLabel();
            this.activate(event.get_button());
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('leave-event', () => {
            this._pressed = false;
            this.icon.opacity = 255;
        });
        this.actor.connect('destroy', () => {
            this._destroyed = true;
            this.onDestroy();
        });

        this.setScale(1);
    }

    get restWidth() {
        return this.basePx + this.gapPx;
    }

    get width() {
        return this.basePx * this.scale + this.gapPx;
    }

    setScale(s) {
        this.scale = s;
        const w = this.width;
        this.actor.set_size(w, this.height);
        this.icon.set_position((w - this.maxPx) / 2, this.basePx - this.maxPx);
        const k = s / MAGNIFICATION;
        this.icon.set_scale(k, k);
        this.dot.set_position((w - this.dot.width) / 2, this.basePx + (this.height - this.basePx - this.dot.height) / 2);
    }

    setRunning(running) {
        this.dot.visible = running;
    }

    bounce(untilRunning = false) {
        if (this._bouncing)
            return;
        this._bouncing = true;
        const start = GLib.get_monotonic_time();
        const height = this.basePx * 0.5;
        const once = () => {
            this.icon.ease({
                translation_y: -height,
                duration: 280,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.icon.ease({
                    translation_y: 0,
                    duration: 280,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (this._destroyed)
                            return;
                        const elapsed = (GLib.get_monotonic_time() - start) / 1000;
                        if (untilRunning && !this.isRunning() && elapsed < 7000)
                            once();
                        else
                            this._bouncing = false;
                    },
                }),
            });
        };
        once();
    }

    isRunning() {
        return true;
    }

    activate(_button) {}

    openMenu() {}

    destroy() {
        this.actor.destroy();
    }

    onDestroy() {}
}

class AppItem extends DockItem {
    constructor(dock, app) {
        const icon = app.create_icon_texture(Math.round(ICON_SIZE * MAGNIFICATION));
        super(dock, icon, app.get_name());
        this.app = app;
    }

    isRunning() {
        return this.app.state === Shell.AppState.RUNNING;
    }

    activate(button) {
        const app = this.app;
        const running = app.state !== Shell.AppState.STOPPED;
        const event = Clutter.get_current_event();
        const ctrl = event && (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (running && (button === Clutter.BUTTON_MIDDLE || ctrl) && app.can_open_new_window()) {
            this.bounce();
            app.open_new_window(-1);
            return;
        }

        if (!running) {
            this.bounce(true);
            app.activate();
            return;
        }

        const windows = app.get_windows().filter(w => !w.skip_taskbar);
        const focused = Shell.WindowTracker.get_default().focus_app === app;
        if (focused && windows.length > 1) {
            // Cycle through the app's windows (list is most-recently-used first).
            Main.activateWindow(windows[windows.length - 1]);
        } else if (focused && windows.length === 1 && windows[0].can_minimize()) {
            windows[0].minimize();
        } else {
            app.activate();
        }
    }

    openMenu() {
        if (!this._menu) {
            this._menu = new AppMenu(this.actor, St.Side.BOTTOM, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);
            this._menu.connect('open-state-changed', (m, open) => this.dock.onMenuState(open));
            Main.uiGroup.add_child(this._menu.actor);
            this.dock.menuManager.addMenu(this._menu);
        }
        this.dock.hideLabel();
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    onDestroy() {
        this._menu?.destroy();
        this._menu = null;
    }
}

class LaunchpadItem extends DockItem {
    constructor(dock) {
        const sf = scaleFactor();
        const size = Math.round(ICON_SIZE * MAGNIFICATION);
        const wrapper = new St.Bin({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const tile = new St.Bin({
            style_class: 'macdock-launchpad',
            style: `border-radius: ${Math.round(size * 0.24)}px;`,
            child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: Math.round(size * 0.5)}),
        });
        tile.set_size(size * 0.84 * sf, size * 0.84 * sf);
        wrapper.set_child(tile);
        super(dock, wrapper, 'Applications');
    }

    activate() {
        if (Main.overview.visible)
            Main.overview.hide();
        else
            Main.overview.showApps();
    }
}

class TrashItem extends DockItem {
    constructor(dock) {
        const icon = new St.Icon({
            icon_name: 'user-trash',
            icon_size: Math.round(ICON_SIZE * MAGNIFICATION),
        });
        super(dock, icon, 'Trash');
        this._file = Gio.File.new_for_uri('trash:///');
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._update());
        } catch (e) {
            console.warn(`Mac Dock: cannot monitor trash: ${e.message}`);
        }
        this._update();
    }

    _update() {
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (file, res) => {
                if (this._destroyed)
                    return;
                try {
                    const info = file.query_info_finish(res);
                    const count = info.get_attribute_uint32('trash::item-count');
                    this.icon.icon_name = count > 0 ? 'user-trash-full' : 'user-trash';
                } catch (e) {
                    // gvfs may be unavailable; keep the empty icon
                }
            });
    }

    activate() {
        try {
            Gio.AppInfo.launch_default_for_uri('trash:///', global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Could not open Trash', e.message);
        }
    }

    onDestroy() {
        this._monitor?.cancel();
        this._monitor = null;
    }
}

class SeparatorItem {
    constructor() {
        const sf = scaleFactor();
        this.magnify = false;
        this.restWidth = SEPARATOR_WIDTH * sf;
        this.width = this.restWidth;
        this.actor = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.actor.set_size(this.restWidth, (ICON_SIZE + DOT_SPACE) * sf);
        const line = new St.Widget({style_class: 'macdock-separator-line'});
        line.set_size(Math.max(1, sf), ICON_SIZE * 0.8 * sf);
        line.set_position((this.restWidth - line.width) / 2, ICON_SIZE * 0.1 * sf);
        this.actor.add_child(line);
    }

    setScale() {}

    destroy() {
        this.actor.destroy();
    }
}

class Dock {
    constructor(extension) {
        this._extension = extension;
        this._amount = 0;          // 0..1, how "on" magnification currently is
        this._pointerX = 0;
        this._menuOpen = false;
        this._hoveredItem = null;
        this._appItems = new Map(); // app id -> AppItem
        this._runningOrder = [];    // ids of running, non-favorite apps, in dock order
        this._items = [];

        this._container = new St.Widget({
            style_class: 'macdock-container',
            layout_manager: new Clutter.BinLayout(),
        });
        this._box = new St.BoxLayout({
            style_class: 'macdock',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        this._container.add_child(this._box);

        this.menuManager = new PopupMenu.PopupMenuManager(this._box);

        this._label = new St.Label({style_class: 'macdock-label', visible: false});
        Main.uiGroup.add_child(this._label);

        this._box.connect('motion-event', (a, event) => {
            [this._pointerX] = event.get_coords();
            this._updateMagnification();
            return Clutter.EVENT_PROPAGATE;
        });
        this._box.connect('notify::hover', () => this._syncHover());

        Main.layoutManager.addChrome(this._container, {
            affectsStruts: true,
            trackFullscreen: true,
        });

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject(
            'installed-changed', () => this._refresh(),
            'app-state-changed', () => this._refresh(),
            this);
        AppFavorites.getAppFavorites().connectObject('changed', () => this._refresh(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._rebuild(),
            'startup-complete', () => this._relayout(),
            this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._rebuild(), this);
        Main.overview.connectObject(
            'showing', () => this._setShown(false),
            'hiding', () => this._setShown(true),
            this);
        this._box.connect('style-changed', () => this._relayout());

        this._rebuild();
        this._setShown(!Main.overview.visible, false);
    }

    // --- building --------------------------------------------------------

    _rebuild() {
        for (const item of this._items)
            item.destroy();
        this._items = [];
        this._appItems.clear();
        this._launchpad = SHOW_LAUNCHPAD ? new LaunchpadItem(this) : null;
        this._trash = SHOW_TRASH ? new TrashItem(this) : null;
        this._refresh();
        this._relayout();
    }

    _refresh() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favIds = new Set(favorites.map(a => a.get_id()));
        const running = this._appSystem.get_running().filter(a => !favIds.has(a.get_id()));
        const runningIds = new Set(running.map(a => a.get_id()));

        // Keep existing order for running apps, append newly started ones at the end.
        this._runningOrder = this._runningOrder.filter(id => runningIds.has(id));
        for (const app of running) {
            if (!this._runningOrder.includes(app.get_id()))
                this._runningOrder.push(app.get_id());
        }
        const runningApps = this._runningOrder.map(id => running.find(a => a.get_id() === id));

        const wanted = [...favorites, ...runningApps];
        const wantedIds = new Set(wanted.map(a => a.get_id()));

        for (const [id, item] of this._appItems) {
            if (!wantedIds.has(id)) {
                item.destroy();
                this._appItems.delete(id);
            }
        }
        for (const item of this._items) {
            if (item instanceof SeparatorItem)
                item.destroy();
        }

        const items = [];
        if (this._launchpad)
            items.push(this._launchpad, new SeparatorItem());
        const appItem = app => {
            let item = this._appItems.get(app.get_id());
            if (!item) {
                item = new AppItem(this, app);
                this._appItems.set(app.get_id(), item);
            }
            item.setRunning(app.state !== Shell.AppState.STOPPED);
            return item;
        };
        items.push(...favorites.map(appItem));
        if (runningApps.length > 0)
            items.push(new SeparatorItem(), ...runningApps.map(appItem));
        if (this._trash)
            items.push(new SeparatorItem(), this._trash);

        this._items = items;
        items.forEach((item, i) => {
            const parent = item.actor.get_parent();
            if (parent !== this._box) {
                parent?.remove_child(item.actor);
                this._box.insert_child_at_index(item.actor, i);
            } else {
                this._box.set_child_at_index(item.actor, i);
            }
        });
        this._updateMagnification();
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._container.get_stage())
            return;
        const [, height] = this._container.get_preferred_height(monitor.width);
        this._container.set_size(monitor.width, height);
        this._container.set_position(monitor.x, monitor.y + monitor.height - height);
    }

    // --- magnification ---------------------------------------------------

    _syncHover() {
        if (this._menuOpen)
            return;
        const hovered = this._box.hover && this._shown;
        this._animateAmount(hovered ? 1 : 0);
        if (!hovered)
            this.hideLabel();
    }

    _animateAmount(target) {
        this._timeline?.stop();
        this._timeline = null;
        const from = this._amount;
        if (from === target)
            return;
        const timeline = new Clutter.Timeline({
            actor: this._box,
            duration: 170,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        timeline.connect('new-frame', t => {
            this._amount = from + (target - from) * t.get_progress();
            this._updateMagnification();
        });
        timeline.connect('completed', () => {
            this._amount = target;
            this._updateMagnification();
        });
        this._timeline = timeline;
        timeline.start();
    }

    _updateMagnification() {
        if (this._items.length === 0)
            return;
        const node = this._box.get_theme_node();
        const padL = node.get_padding(St.Side.LEFT) + node.get_border_width(St.Side.LEFT);
        const padR = node.get_padding(St.Side.RIGHT) + node.get_border_width(St.Side.RIGHT);
        const padT = node.get_padding(St.Side.TOP) + node.get_border_width(St.Side.TOP);
        const [containerX] = this._container.get_transformed_position();
        const containerW = this._container.width;
        const unit = ICON_SIZE * scaleFactor() + ICON_GAP * scaleFactor();

        // Zoom is computed against the resting layout so it doesn't feed back on itself.
        const restW = padL + padR + this._items.reduce((sum, it) => sum + it.restWidth, 0);
        let restX = containerX + (containerW - restW) / 2 + padL;
        for (const item of this._items) {
            let s = 1;
            if (item.magnify && this._amount > 0) {
                const d = Math.abs(this._pointerX - (restX + item.restWidth / 2)) / unit;
                if (d < MAG_RANGE)
                    s = 1 + (MAGNIFICATION - 1) * this._amount * (1 + Math.cos(Math.PI * d / MAG_RANGE)) / 2;
            }
            item.setScale(s);
            restX += item.restWidth;
        }

        if (this._hoveredItem && this._label.visible) {
            const magW = padL + padR + this._items.reduce((sum, it) => sum + it.width, 0);
            let x = containerX + (containerW - magW) / 2 + padL;
            for (const item of this._items) {
                if (item === this._hoveredItem)
                    break;
                x += item.width;
            }
            const item = this._hoveredItem;
            const [, boxY] = this._box.get_transformed_position();
            const iconTop = boxY + padT + item.basePx * (1 - item.scale);
            const [, , labelW, labelH] = this._label.get_preferred_size();
            this._label.set_position(
                Math.round(x + item.width / 2 - labelW / 2),
                Math.round(iconTop - labelH - 8 * scaleFactor()));
        }
    }

    // --- labels, menus, visibility --------------------------------------

    onItemHover(item) {
        if (item.actor.hover && !this._menuOpen) {
            this._hoveredItem = item;
            this._label.text = item.labelText;
            this._label.show();
            this._updateMagnification();
        } else if (this._hoveredItem === item) {
            this.hideLabel();
        }
    }

    hideLabel() {
        this._hoveredItem = null;
        this._label.hide();
    }

    onMenuState(open) {
        this._menuOpen = open;
        if (!open)
            this._syncHover();
    }

    _setShown(shown, animate = true) {
        this._shown = shown;
        this._box.reactive = shown;
        if (!shown)
            this.hideLabel();
        this._container.remove_all_transitions();
        const props = {
            opacity: shown ? 255 : 0,
            translation_y: shown ? 0 : this._container.height,
        };
        if (animate) {
            this._container.ease({
                ...props,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._container.set(props);
        }
        this._syncHover();
    }

    destroy() {
        this._timeline?.stop();
        this._appSystem.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        for (const item of this._items)
            item.destroy();
        this._items = [];
        this._label.destroy();
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }
}

export default class MacDockExtension extends Extension {
    enable() {
        this._dock = new Dock(this);
    }

    disable() {
        this._dock?.destroy();
        this._dock = null;
    }
}
