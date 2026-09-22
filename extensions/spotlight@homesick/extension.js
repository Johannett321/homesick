// Spotlight — a Spotlight/Raycast-style launcher for GNOME Shell (Alt+Space).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---- Tweakables -------------------------------------------------------------
const SHORTCUT = '<Alt>space';
const PANEL_WIDTH = 700;            // logical px
const VISIBLE_ROWS = 8;
const MAX_RESULTS = 40;
const FILE_SEARCH_DEPTH = 7;        // how deep below ~ to look for files
const FILE_SEARCH_LIMIT = 30;
const FILE_SEARCH_DELAY = 180;      // ms to wait after typing before searching files
const WEB_SEARCH_URL = 'https://www.google.com/search?q=';
const WEB_SEARCH_NAME = 'Google';
const SKIP_DIRS = ['node_modules', '__pycache__', 'snap', 'target', 'venv'];
// -----------------------------------------------------------------------------

const HOME = GLib.get_home_dir();

function themedIcon(...names) {
    return Gio.ThemedIcon.new_from_names(names);
}

function tildify(path) {
    return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

function expandTilde(path) {
    return path === '~' || path.startsWith('~/') ? HOME + path.slice(1) : path;
}

function launchUri(uri) {
    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
}

function showInFiles(path) {
    const uri = Gio.File.new_for_path(path).get_uri();
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

function copyToClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

// Rough "how well does query match text", 0..100.
function matchScore(query, text) {
    if (!text)
        return 0;
    const t = text.toLowerCase();
    const q = query;
    if (t === q)
        return 100;
    if (t.startsWith(q))
        return 92 - Math.min(8, (t.length - q.length) / 3);
    const words = t.split(/[\s\-_.()/]+/).filter(w => w);
    if (words.some(w => w.startsWith(q)))
        return 80;
    if (q.length >= 2 && words.map(w => w[0]).join('').startsWith(q))
        return 76;
    if (t.includes(q))
        return 66;
    // Fuzzy: all query characters in order, penalised by the gaps between them.
    let i = 0, last = -1, gaps = 0;
    for (let j = 0; j < t.length && i < q.length; j++) {
        if (t[j] === q[i]) {
            if (last >= 0)
                gaps += j - last - 1;
            last = j;
            i++;
        }
    }
    if (i === q.length && q.length >= 2)
        return Math.max(15, 50 - gaps * 3);
    return 0;
}

// ---- Calculator -------------------------------------------------------------

const CALC_FUNCS = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    ln: Math.log, log: Math.log10, log2: Math.log2,
    round: Math.round, floor: Math.floor, ceil: Math.ceil,
};
const CALC_CONSTS = {pi: Math.PI, e: Math.E, tau: 2 * Math.PI};

function tokenize(src) {
    const tokens = [];
    const re = /\s*(?:(\d+(?:[.,]\d+)?(?:e[+-]?\d+)?|[.,]\d+)|([a-zπ]+\d?)|(\*\*|[-+*/^%()×÷x!]))/iy;
    let m;
    while (re.lastIndex < src.length) {
        const start = re.lastIndex;
        if (/^\s*$/.test(src.slice(start)))
            break;
        m = re.exec(src);
        if (!m)
            return null;
        if (m[1] !== undefined)
            tokens.push({type: 'num', value: parseFloat(m[1].replace(',', '.'))});
        else if (m[2] !== undefined && m[2].toLowerCase() !== 'x')
            tokens.push({type: 'id', value: m[2].toLowerCase().replace('π', 'pi')});
        else
            tokens.push({type: 'op', value: {'×': '*', 'x': '*', 'X': '*', '÷': '/', '**': '^'}[m[2] ?? m[3]] ?? m[3]});
    }
    return tokens;
}

function evaluate(src) {
    const tokens = tokenize(src);
    if (!tokens || tokens.length === 0)
        return null;
    let pos = 0;
    const peek = () => tokens[pos];
    const isOp = v => peek()?.type === 'op' && peek().value === v;

    const expr = () => {
        let v = term();
        while (isOp('+') || isOp('-')) {
            const op = tokens[pos++].value;
            const r = term();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    };
    const term = () => {
        let v = unary();
        for (;;) {
            if (isOp('*') || isOp('/') || isOp('%')) {
                const op = tokens[pos++].value;
                const r = unary();
                v = op === '*' ? v * r : op === '/' ? v / r : v % r;
            } else if (peek() && (peek().type !== 'op' || peek().value === '(')) {
                v *= unary(); // implicit multiplication: 2pi, 3(4+1)
            } else {
                return v;
            }
        }
    };
    const unary = () => {
        if (isOp('-')) {
            pos++;
            return -unary();
        }
        if (isOp('+')) {
            pos++;
            return unary();
        }
        return power();
    };
    const power = () => {
        const base = postfix();
        if (isOp('^')) {
            pos++;
            return base ** unary();
        }
        return base;
    };
    const postfix = () => {
        let v = primary();
        while (isOp('!')) {
            pos++;
            if (v < 0 || v > 170 || !Number.isInteger(v))
                throw new Error('bad factorial');
            let f = 1;
            for (let i = 2; i <= v; i++)
                f *= i;
            v = f;
        }
        return v;
    };
    const primary = () => {
        const t = tokens[pos++];
        if (!t)
            throw new Error('unexpected end');
        if (t.type === 'num')
            return t.value;
        if (t.type === 'id') {
            if (t.value in CALC_CONSTS)
                return CALC_CONSTS[t.value];
            if (t.value in CALC_FUNCS) {
                if (isOp('(')) {
                    pos++;
                    const v = expr();
                    if (!isOp(')'))
                        throw new Error('missing )');
                    pos++;
                    return CALC_FUNCS[t.value](v);
                }
                return CALC_FUNCS[t.value](power());
            }
            throw new Error(`unknown ${t.value}`);
        }
        if (t.value === '(') {
            const v = expr();
            if (isOp(')'))
                pos++; // tolerate a missing closing paren while typing
            return v;
        }
        throw new Error(`unexpected ${t.value}`);
    };

    try {
        const v = expr();
        if (pos !== tokens.length || !Number.isFinite(v))
            return null;
        return v;
    } catch (e) {
        return null;
    }
}

function formatNumber(v) {
    if (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-9 && v !== 0))
        return v.toExponential(8).replace(/\.?0+e/, 'e');
    return String(parseFloat(v.toPrecision(12)));
}

// ---- Usage history (boosts things you pick often) ---------------------------

class History {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'homesick-spotlight']);
        this._path = GLib.build_filenamev([this._dir, 'usage.json']);
        this._data = {};
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (ok)
                this._data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            // first run
        }
    }

    boost(id) {
        return Math.min(20, 4 * Math.log2(1 + (this._data[id] ?? 0)));
    }

    record(id) {
        this._data[id] = (this._data[id] ?? 0) + 1;
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this._path, JSON.stringify(this._data));
        } catch (e) {
            console.warn(`Spotlight: could not save history: ${e.message}`);
        }
    }
}

// ---- Providers --------------------------------------------------------------

function appResults(query, history) {
    const results = [];
    const appSystem = Shell.AppSystem.get_default();
    for (const info of Gio.AppInfo.get_all()) {
        if (!info.should_show())
            continue;
        const id = info.get_id();
        let score = matchScore(query, info.get_name());
        score = Math.max(score,
            0.8 * matchScore(query, info.get_generic_name?.() ?? ''),
            0.75 * matchScore(query, info.get_executable()?.split('/').pop() ?? ''),
            0.7 * Math.max(0, ...(info.get_keywords?.() ?? []).map(k => matchScore(query, k))));
        if (score <= 0)
            continue;
        results.push({
            id: `app:${id}`,
            title: info.get_name(),
            subtitle: info.get_description() ?? '',
            gicon: info.get_icon() ?? themedIcon('application-x-executable'),
            kind: 'Application',
            score: score + history.boost(`app:${id}`),
            activate: () => {
                const app = appSystem.lookup_app(id);
                if (app)
                    app.activate();
                else
                    info.launch([], global.create_app_launch_context(0, -1));
            },
        });
    }
    return results;
}

let _settingsPanels = null;
function settingsResults(query, history) {
    if (!_settingsPanels) {
        _settingsPanels = [];
        const dirs = [...GLib.get_system_data_dirs(), GLib.get_user_data_dir()];
        const seen = new Set();
        for (const dir of dirs) {
            const path = GLib.build_filenamev([dir, 'applications']);
            let enumerator;
            try {
                enumerator = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
            } catch (e) {
                continue;
            }
            let fi;
            while ((fi = enumerator.next_file(null))) {
                const name = fi.get_name();
                if (!/^gnome-.*-panel\.desktop$/.test(name) || seen.has(name))
                    continue;
                seen.add(name);
                const info = GioUnix.DesktopAppInfo.new(name);
                if (info)
                    _settingsPanels.push(info);
            }
        }
    }
    const results = [];
    for (const info of _settingsPanels) {
        const score = Math.max(matchScore(query, info.get_name()),
            0.7 * Math.max(0, ...(info.get_keywords() ?? []).map(k => matchScore(query, k))));
        if (score <= 0)
            continue;
        const id = `settings:${info.get_id()}`;
        results.push({
            id,
            title: info.get_name(),
            subtitle: info.get_description() ?? '',
            gicon: info.get_icon() ?? themedIcon('preferences-system'),
            kind: 'Settings',
            score: score * 0.88 + history.boost(id),
            activate: () => info.launch([], global.create_app_launch_context(0, -1)),
        });
    }
    return results;
}

function windowResults(query) {
    const tracker = Shell.WindowTracker.get_default();
    const results = [];
    for (const actor of global.get_window_actors()) {
        const win = actor.meta_window;
        if (win.skip_taskbar || win.get_window_type() !== Meta.WindowType.NORMAL)
            continue;
        const app = tracker.get_window_app(win);
        const title = win.get_title() ?? '';
        const score = Math.max(matchScore(query, title), 0.9 * matchScore(query, app?.get_name()));
        if (score <= 0)
            continue;
        results.push({
            id: `win:${win.get_id()}`,
            title,
            subtitle: app ? `${app.get_name()} — open window` : 'Open window',
            gicon: app?.get_icon() ?? themedIcon('focus-windows-symbolic'),
            kind: 'Window',
            score: score * 0.8,
            activate: () => Main.activateWindow(win),
        });
    }
    return results;
}

const SYSTEM_ACTIONS = [
    {name: 'Lock Screen', keywords: ['lock'], icon: ['system-lock-screen', 'system-lock-screen-symbolic'],
        run: () => Main.screenShield.lock(true)},
    {name: 'Suspend', keywords: ['sleep', 'suspend'], icon: ['weather-clear-night-symbolic'],
        run: () => GLib.spawn_command_line_async('systemctl suspend')},
    {name: 'Log Out', keywords: ['logout', 'sign out'], icon: ['system-log-out', 'system-log-out-symbolic'],
        run: () => GLib.spawn_command_line_async('gnome-session-quit --logout')},
    {name: 'Restart', keywords: ['reboot', 'restart'], icon: ['system-reboot', 'system-reboot-symbolic'],
        run: () => GLib.spawn_command_line_async('gnome-session-quit --reboot')},
    {name: 'Shut Down', keywords: ['power off', 'shutdown', 'turn off'], icon: ['system-shutdown', 'system-shutdown-symbolic'],
        run: () => GLib.spawn_command_line_async('gnome-session-quit --power-off')},
    {name: 'Empty Trash', keywords: ['trash', 'bin'], icon: ['user-trash-full', 'user-trash-full-symbolic'],
        run: () => GLib.spawn_command_line_async('gio trash --empty')},
    {name: 'Open Trash', keywords: ['trash', 'bin'], icon: ['user-trash', 'user-trash-symbolic'],
        run: () => launchUri('trash:///')},
];

function systemResults(query, history) {
    const results = [];
    for (const action of SYSTEM_ACTIONS) {
        const score = Math.max(matchScore(query, action.name),
            ...action.keywords.map(k => 0.9 * matchScore(query, k)));
        if (score <= 0)
            continue;
        const id = `sys:${action.name}`;
        results.push({
            id,
            title: action.name,
            subtitle: 'System command',
            gicon: themedIcon(...action.icon),
            kind: 'Command',
            score: score * 0.9 + history.boost(id),
            activate: action.run,
        });
    }
    return results;
}

function calcResult(text) {
    // Only treat it as maths if there's something mathematical in it.
    if (!/[\d)]\s*[-+*/^%×÷!x]|^\s*-?\s*[a-z]+\s*\(|\b(pi|sqrt|sin|cos|tan|ln|log)\b|[0-9]\s*!/i.test(text))
        return null;
    const v = evaluate(text);
    if (v === null)
        return null;
    const s = formatNumber(v);
    return {
        id: 'calc',
        title: `= ${s}`,
        subtitle: `${text.trim()}  ·  Enter copies the result`,
        gicon: themedIcon('accessories-calculator', 'accessories-calculator-symbolic'),
        kind: 'Calculator',
        calc: true,
        score: 1000,
        noHistory: true,
        activate: () => copyToClipboard(s),
    };
}

function urlResult(text) {
    const t = text.trim();
    if (/\s/.test(t) || !/^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t))
        return null;
    const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    return {
        id: 'url',
        title: `Open ${t}`,
        subtitle: url,
        gicon: themedIcon('web-browser', 'web-browser-symbolic'),
        kind: 'Link',
        score: 95,
        noHistory: true,
        activate: () => launchUri(url),
    };
}

function webResult(text) {
    return {
        id: 'web',
        title: `Search ${WEB_SEARCH_NAME} for “${text.trim()}”`,
        subtitle: 'Opens in your web browser',
        gicon: themedIcon('web-browser', 'web-browser-symbolic'),
        kind: 'Web',
        score: -1,
        noHistory: true,
        activate: () => launchUri(WEB_SEARCH_URL + encodeURIComponent(text.trim())),
    };
}

function fileResult(path, isDir, score) {
    const name = GLib.path_get_basename(path);
    const gicon = isDir
        ? themedIcon('folder', 'folder-symbolic')
        : Gio.content_type_get_icon(Gio.content_type_guess(name, null)[0]);
    return {
        id: `file:${path}`,
        title: name,
        subtitle: tildify(GLib.path_get_dirname(path)),
        gicon,
        kind: isDir ? 'Folder' : 'File',
        score,
        path,
        isDir,
        activate: () => launchUri(Gio.File.new_for_path(path).get_uri()),
        reveal: () => showInFiles(path),
    };
}

// Typing a path (~/Doc…, /etc/…) lists what's in that folder.
function pathResults(text) {
    const expanded = expandTilde(text.trim());
    if (!expanded.startsWith('/'))
        return null;
    const slash = expanded.lastIndexOf('/');
    const dir = expanded.slice(0, slash) || '/';
    const prefix = expanded.slice(slash + 1).toLowerCase();
    const results = [];
    try {
        const enumerator = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name,standard::type,standard::is-hidden', Gio.FileQueryInfoFlags.NONE, null);
        let fi, count = 0;
        while ((fi = enumerator.next_file(null)) && count < 500) {
            count++;
            const name = fi.get_name();
            if (fi.get_is_hidden() && !prefix.startsWith('.'))
                continue;
            if (prefix && !name.toLowerCase().startsWith(prefix))
                continue;
            const isDir = fi.get_file_type() === Gio.FileType.DIRECTORY;
            results.push(fileResult(GLib.build_filenamev([dir, name]), isDir, isDir ? 51 : 50));
        }
        enumerator.close(null);
    } catch (e) {
        return [];
    }
    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return results;
}

// Searches your home folder with `find`, streaming results as they arrive.
class FileSearch {
    constructor() {
        this._proc = null;
        this._cancellable = null;
    }

    cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        try {
            this._proc?.force_exit();
        } catch (e) {
            // already gone
        }
        this._proc = null;
    }

    search(query, onResults) {
        this.cancel();
        const pattern = `*${query.replace(/([*?[\]\\])/g, '\\$1')}*`;
        const prune = ['(', '-name', '.*'];
        for (const d of SKIP_DIRS)
            prune.push('-o', '-name', d);
        prune.push(')', '-prune', '-o');
        const argv = ['find', HOME, '-mindepth', '1', '-maxdepth', String(FILE_SEARCH_DEPTH),
            ...prune, '-iname', pattern, '-printf', '%y %p\\n'];

        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Spotlight: file search failed: ${e.message}`);
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._proc = proc;
        this._cancellable = cancellable;

        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const found = [];
        const q = query.toLowerCase();
        let flushId = 0;
        const flush = () => {
            if (flushId) {
                GLib.source_remove(flushId);
                flushId = 0;
            }
            if (!cancellable.is_cancelled())
                onResults([...found]);
        };
        const readLine = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                let line;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (e) {
                    return; // cancelled
                }
                if (line === null || found.length >= FILE_SEARCH_LIMIT) {
                    flush();
                    if (this._proc === proc)
                        this.cancel();
                    return;
                }
                const isDir = line[0] === 'd';
                const path = line.slice(2);
                const name = GLib.path_get_basename(path);
                const depth = path.split('/').length;
                const score = 20 + matchScore(q, name) * 0.45 - depth * 0.5;
                found.push(fileResult(path, isDir, score));
                // Batch UI updates a little so rows don't flicker in one by one.
                if (!flushId) {
                    flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                        flushId = 0;
                        flush();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                readLine();
            });
        };
        readLine();
    }
}

// ---- UI ---------------------------------------------------------------------

class ResultRow {
    constructor(result, onHover, onClick) {
        this.result = result;
        this.actor = new St.BoxLayout({
            style_class: 'spotlight-row',
            reactive: true,
            track_hover: true,
        });
        const icon = new St.Icon({
            gicon: result.gicon,
            icon_size: result.calc ? 36 : 30,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(icon);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            text: result.title,
            style_class: result.calc ? 'spotlight-calc-title' : 'spotlight-title',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);
        if (result.subtitle) {
            const sub = new St.Label({text: result.subtitle, style_class: 'spotlight-subtitle'});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            text.add_child(sub);
        }
        this.actor.add_child(text);

        this.actor.add_child(new St.Label({
            text: result.kind,
            style_class: 'spotlight-kind',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.actor.connect('motion-event', () => {
            onHover(this);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('button-release-event', (a, event) => {
            onClick(this, event);
            return Clutter.EVENT_STOP;
        });
    }

    setSelected(selected) {
        if (selected)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
    }
}

class Spotlight {
    constructor() {
        this._history = new History();
        this._fileSearch = new FileSearch();
        this._rows = [];
        this._selected = 0;
        this._scrollTop = 0;
        this._fileResults = [];
        this._fileTimeoutId = 0;
        this._grab = null;
        this._isOpen = false;

        this._container = new St.Widget({
            reactive: true,
            visible: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._container.connect('button-press-event', (a, event) => {
            // Click outside the panel closes it.
            const [x, y] = event.get_coords();
            const [px, py] = this._panel.get_transformed_position();
            const [pw, ph] = this._panel.get_transformed_size();
            if (x < px || x > px + pw || y < py || y > py + ph)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this._panel = new St.BoxLayout({
            style_class: 'spotlight-panel',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._container.add_child(this._panel);

        const searchRow = new St.BoxLayout({style_class: 'spotlight-search-row'});
        searchRow.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 22,
            style_class: 'spotlight-search-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._entry = new St.Entry({
            style_class: 'spotlight-entry',
            hint_text: 'Search apps, files, maths, settings…',
            can_focus: true,
            x_expand: true,
        });
        searchRow.add_child(this._entry);
        this._panel.add_child(searchRow);

        this._resultsBox = new St.BoxLayout({
            style_class: 'spotlight-results',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._panel.add_child(this._resultsBox);

        this._footer = new St.Label({style_class: 'spotlight-footer', visible: false});
        this._panel.add_child(this._footer);

        this._entry.clutter_text.connect('text-changed', () => this._onTextChanged());
        this._entry.clutter_text.connect('key-press-event', (a, event) => this._onKeyPress(event));

        Main.layoutManager.addTopChrome(this._container);
    }

    toggle() {
        // Alt+Space can arrive both through our key handler and the global
        // shortcut; ignore a second toggle straight after the first.
        const now = GLib.get_monotonic_time();
        if (now - (this._closedAt ?? 0) < 300000 || now - (this._openedAt ?? 0) < 300000)
            return;
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._isOpen)
            return;
        if (Main.overview.visible)
            Main.overview.hide();

        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._container.set_position(0, 0);
        this._container.set_size(global.stage.width, global.stage.height);
        const width = Math.min(PANEL_WIDTH * sf, monitor.width - 40 * sf);
        this._panel.width = width;
        this._panel.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height * 0.2));

        this._container.show();
        this._isOpen = true;
        try {
            this._grab = Main.pushModal(this._container, {actionMode: Shell.ActionMode.POPUP});
            this._entry.text = '';
            this._render([]);
            this._entry.grab_key_focus();
        } catch (e) {
            console.error(`Spotlight: failed to open: ${e.message}`);
            this.close();
            return;
        }
        this._openedAt = GLib.get_monotonic_time();

        this._panel.set_pivot_point(0.5, 0.5);
        this._panel.opacity = 0;
        this._panel.set_scale(0.97, 0.97);
        this._panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        // Always release the screen, even if something below throws.
        this._isOpen = false;
        this._closedAt = GLib.get_monotonic_time();
        try {
            this._cancelFileSearch();
        } catch (e) {
            console.error(`Spotlight: ${e.message}`);
        }
        if (this._grab) {
            const grab = this._grab;
            this._grab = null;
            try {
                Main.popModal(grab);
            } catch (e) {
                console.error(`Spotlight: ${e.message}`);
            }
        }
        this._panel.remove_all_transitions();
        this._container.hide();
        this._entry.text = '';
    }

    _cancelFileSearch() {
        if (this._fileTimeoutId) {
            GLib.source_remove(this._fileTimeoutId);
            this._fileTimeoutId = 0;
        }
        this._fileSearch.cancel();
    }

    _onTextChanged() {
        if (!this._isOpen)
            return;
        const text = this._entry.text;
        const query = text.trim().toLowerCase();
        this._cancelFileSearch();
        this._fileResults = [];

        if (!query) {
            this._render([]);
            return;
        }

        const paths = pathResults(text);
        if (paths !== null) {
            this._syncResults = paths;
            this._render(paths);
            return;
        }

        const results = [
            ...appResults(query, this._history),
            ...settingsResults(query, this._history),
            ...systemResults(query, this._history),
            ...windowResults(query),
        ];
        const calc = calcResult(text);
        if (calc)
            results.push(calc);
        const url = urlResult(text);
        if (url)
            results.push(url);
        results.push(webResult(text));
        this._syncResults = results;
        this._render(this._merged());

        if (query.length >= 2 && !calc) {
            this._fileTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILE_SEARCH_DELAY, () => {
                this._fileTimeoutId = 0;
                this._fileSearch.search(query, files => {
                    for (const f of files)
                        f.score += this._history.boost(f.id);
                    this._fileResults = files;
                    this._render(this._merged(), true);
                });
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _merged() {
        return [...this._syncResults, ...this._fileResults]
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_RESULTS);
    }

    _render(results, keepSelection = false) {
        const selectedId = keepSelection ? this._rows[this._selected]?.result.id : null;
        this._resultsBox.destroy_all_children();
        this._rows = results.map(r => new ResultRow(r,
            row => this._select(this._rows.indexOf(row), false),
            (row, event) => this._activate(this._rows.indexOf(row), event)));
        for (const row of this._rows)
            this._resultsBox.add_child(row.actor);

        let index = 0;
        if (selectedId) {
            const i = this._rows.findIndex(r => r.result.id === selectedId);
            index = i >= 0 ? i : 0;
        }
        this._scrollTop = 0;
        this._resultsBox.visible = this._rows.length > 0;
        this._footer.visible = this._rows.length > 0;
        this._select(index, true);
    }

    _select(index, scroll = true) {
        if (this._rows.length === 0)
            return;
        index = Math.max(0, Math.min(index, this._rows.length - 1));
        this._rows[this._selected]?.setSelected(false);
        this._selected = index;
        this._rows[index].setSelected(true);

        if (scroll) {
            if (index < this._scrollTop)
                this._scrollTop = index;
            else if (index >= this._scrollTop + VISIBLE_ROWS)
                this._scrollTop = index - VISIBLE_ROWS + 1;
            this._rows.forEach((row, i) => {
                row.actor.visible = i >= this._scrollTop && i < this._scrollTop + VISIBLE_ROWS;
            });
        }

        const r = this._rows[index].result;
        let hint = r.calc ? '↵  Copy result' : '↵  Open';
        if (r.reveal)
            hint += '     Ctrl+↵  Show in Files     Alt+↵  Copy path';
        if (r.isDir)
            hint += '     Tab  Go into folder';
        this._footer.text = `${hint}     Esc  Close`;
    }

    _activate(index, event) {
        const row = this._rows[index];
        if (!row)
            return;
        const r = row.result;
        const state = event?.get_state() ?? 0;
        this.close();
        try {
            if (r.reveal && (state & Clutter.ModifierType.CONTROL_MASK))
                r.reveal();
            else if (r.path && (state & Clutter.ModifierType.MOD1_MASK))
                copyToClipboard(r.path);
            else
                r.activate();
            if (!r.noHistory)
                this._history.record(r.id);
        } catch (e) {
            Main.notifyError(`Could not open ${r.title}`, e.message);
        }
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_space:
            if (event.get_state() & Clutter.ModifierType.MOD1_MASK) {
                this.toggle();
                return Clutter.EVENT_STOP;
            }
            break;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._select(this._selected + VISIBLE_ROWS);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._select(this._selected - VISIBLE_ROWS);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab: {
            // Autocomplete into the selected folder, like a terminal.
            const r = this._rows[this._selected]?.result;
            if (r?.isDir) {
                this._entry.text = `${tildify(r.path)}/`;
                this._entry.clutter_text.set_cursor_position(-1);
            } else {
                this._select(this._selected + 1);
            }
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate(this._selected, event);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this.close();
        this._cancelFileSearch();
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }
}

export default class SpotlightExtension extends Extension {
    enable() {
        this._spotlight = new Spotlight();
        this._action = global.display.grab_accelerator(SHORTCUT, Meta.KeyBindingFlags.NONE);
        if (this._action === Meta.KeyBindingAction.NONE) {
            console.warn(`Spotlight: could not grab ${SHORTCUT} — is something else using it?`);
        } else {
            const name = Meta.external_binding_name_for_action(this._action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
            this._acceleratorId = global.display.connect('accelerator-activated', (display, action) => {
                if (action === this._action)
                    this._spotlight.toggle();
            });
        }
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
        this._spotlight?.destroy();
        this._spotlight = null;
    }
}
