// Option Resize — macOS-style modifier resizing for GNOME Shell.
//   Super (the "opt | start" key) + drag near an edge/corner → resize symmetrically
//   Shift + drag an edge/corner → keep the window's proportions
// Hold the modifier when you start dragging; both can be combined.
//
// Mutter handles move/resize drags before extensions ever see the pointer
// events. Super+drag is mutter's "move window" gesture, so when it starts near
// an edge (or a resize starts with Shift held) we cancel mutter's drag with a
// synthetic Escape and run a resize ourselves until the button is released.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MIN_SIZE = 80;
const EDGE_ZONE = 24;      // how close to an edge (logical px) a Super+drag must start to resize
const CORNER_ZONE = 56;    // ...and how far along that edge still counts as the corner

const G = Meta.GrabOp;
const BASE = G.WINDOW_BASE;
const DIR_N = G.RESIZING_N & ~BASE;
const DIR_S = G.RESIZING_S & ~BASE;
const DIR_E = G.RESIZING_E & ~BASE;
const DIR_W = G.RESIZING_W & ~BASE;
const KEYBOARD_FLAG = G.KEYBOARD_RESIZING_E & ~G.RESIZING_E;

const {SHIFT_MASK, BUTTON1_MASK} = Clutter.ModifierType;
const SUPER_MASK = Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;

function edgesFor(op) {
    if (op & KEYBOARD_FLAG)
        return null;
    const edges = {n: !!(op & DIR_N), s: !!(op & DIR_S), e: !!(op & DIR_E), w: !!(op & DIR_W)};
    return edges.n || edges.s || edges.e || edges.w ? edges : null;
}

// Which edges is the pointer close to? null if it's in the middle of the window.
function edgesNear(rect, px, py) {
    const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const zone = EDGE_ZONE * sf;
    const corner = CORNER_ZONE * sf;
    const left = px - rect.x, right = rect.x + rect.width - px;
    const top = py - rect.y, bottom = rect.y + rect.height - py;
    const edges = {
        w: left < zone && left <= right,
        e: right < zone && right < left,
        n: top < zone && top <= bottom,
        s: bottom < zone && bottom < top,
    };
    if (edges.w || edges.e) {
        edges.n ||= top < corner && top <= bottom;
        edges.s ||= bottom < corner && bottom < top;
    }
    if (edges.n || edges.s) {
        edges.w ||= left < corner && left <= right;
        edges.e ||= right < corner && right < left;
    }
    return edges.n || edges.s || edges.e || edges.w ? edges : null;
}

export default class OptionResizeExtension extends Extension {
    enable() {
        this._drag = null;
        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._beginId = global.display.connect('grab-op-begin', (d, win, op) => this._onGrabBegin(win, op));
    }

    disable() {
        this._finish();
        global.display.disconnect(this._beginId);
        this._keyboard = null;
    }

    _onGrabBegin(win, op) {
        if (this._drag || !win)
            return;
        const [px, py, mods] = global.get_pointer();
        if (!(mods & BUTTON1_MASK))
            return;
        const r = win.get_frame_rect();

        let edges = null;
        const isMove = !(op & (DIR_N | DIR_S | DIR_E | DIR_W | KEYBOARD_FLAG));
        if (isMove) {
            // Super+drag near an edge: resize instead of move.
            const maximized = win.is_maximized() || win.maximized_horizontally || win.maximized_vertically || win.is_fullscreen();
            if ((mods & SUPER_MASK) && win.allows_resize() && !maximized)
                edges = edgesNear(r, px, py);
        } else if (mods & (SUPER_MASK | SHIFT_MASK)) {
            edges = edgesFor(op);
        }
        if (!edges)
            return; // leave it to mutter

        this._drag = {
            win,
            edges,
            rect: {x: r.x, y: r.y, width: r.width, height: r.height},
            px,
            py,
            started: false,
        };

        // Cancel mutter's resize, then take over once it has let go.
        const endId = global.display.connect('grab-op-end', () => {
            global.display.disconnect(endId);
            GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                this._startOwnDrag();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._drag.endId = endId;
        GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            const t = GLib.get_monotonic_time();
            this._keyboard.notify_keyval(t, Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(t + 1, Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
            return GLib.SOURCE_REMOVE;
        });
        // If mutter never lets go, give up rather than leave anything hanging.
        const drag = this._drag;
        drag.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            drag.timeoutId = 0;
            if (this._drag === drag && !drag.started)
                this._finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startOwnDrag() {
        const drag = this._drag;
        if (!drag || drag.started)
            return;
        drag.started = true;
        const [, , mods] = global.get_pointer();
        if (!(mods & BUTTON1_MASK)) {
            this._finish(); // button already released
            return;
        }

        this._actor = new Clutter.Actor({reactive: true});
        this._actor.set_size(global.stage.width, global.stage.height);
        Main.uiGroup.add_child(this._actor);
        try {
            this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        } catch (e) {
            console.error(`Option Resize: ${e.message}`);
            this._finish();
            return;
        }
        this._actor.connect('event', (a, event) => this._onEvent(event));
    }

    _onEvent(event) {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        const state = event.get_state();

        if (type === Clutter.EventType.BUTTON_RELEASE ||
            (type === Clutter.EventType.MOTION && !(state & BUTTON1_MASK))) {
            this._finish();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            const {x, y, width, height} = drag.rect;
            drag.win.move_resize_frame(true, x, y, width, height);
            this._finish();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            const rect = this._compute(drag, x, y, !!(state & SUPER_MASK), !!(state & SHIFT_MASK));
            drag.win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        }
        return Clutter.EVENT_STOP;
    }

    _finish() {
        const drag = this._drag;
        this._drag = null;
        if (drag?.timeoutId)
            GLib.source_remove(drag.timeoutId);
        if (drag?.endId && !drag.started)
            global.display.disconnect(drag.endId);
        if (this._grab) {
            const grab = this._grab;
            this._grab = null;
            try {
                Main.popModal(grab);
            } catch (e) {
                console.error(`Option Resize: ${e.message}`);
            }
        }
        this._actor?.destroy();
        this._actor = null;
    }

    _compute(drag, px, py, symmetric, keepAspect) {
        const {edges, rect: r} = drag;
        const dx = px - drag.px;
        const dy = py - drag.py;
        const k = symmetric ? 2 : 1;
        const horizontal = edges.e || edges.w;
        const vertical = edges.n || edges.s;

        let width = r.width + k * (edges.e ? dx : edges.w ? -dx : 0);
        let height = r.height + k * (edges.s ? dy : edges.n ? -dy : 0);

        if (keepAspect) {
            const scale = Math.max(horizontal ? width / r.width : 0, vertical ? height / r.height : 0);
            width = r.width * scale;
            height = r.height * scale;
        }
        width = Math.round(Math.max(MIN_SIZE, width));
        height = Math.round(Math.max(MIN_SIZE, height));

        let x, y;
        if (symmetric) {
            x = r.x + (r.width - width) / 2;
            y = r.y + (r.height - height) / 2;
        } else {
            // Anchor the opposite edge; an axis we aren't dragging grows around its centre.
            x = edges.w ? r.x + r.width - width : edges.e ? r.x : r.x + (r.width - width) / 2;
            y = edges.n ? r.y + r.height - height : edges.s ? r.y : r.y + (r.height - height) / 2;
        }
        return {x: Math.round(x), y: Math.round(y), width, height};
    }
}
