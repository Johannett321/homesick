// Disk Utility — a macOS-style disk utility for GNOME, built on UDisks2.
//
// Reads drives, partitions, encrypted containers and filesystems from UDisks2
// (the same service GNOME Disks uses) plus /proc/self/mountinfo for Btrfs
// subvolumes. Nothing here needs root; changes to disks go through UDisks and
// polkit, and destructive operations are handed off to GNOME Disks.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import System from 'system';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');

const APP_ID = 'app.homesick.DiskUtility';
const DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const UD = 'org.freedesktop.UDisks2';
const I = name => `${UD}.${name}`;

const COLORS = {
    used: '#1a9ef5',
    other: '#8e8e93',
    partitions: ['#1a9ef5', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#64d2ff', '#ffd60a', '#5e5ce6'],
};

const PARTITION_TYPES = {
    'c12a7328-f81f-11d2-ba4b-00a0c93ec93b': 'EFI System',
    '0fc63daf-8483-4772-8e79-3d69d8477de4': 'Linux Filesystem',
    '4f68bce3-e8cd-4db1-96e7-fbcaf984b709': 'Linux Root (x86-64)',
    '933ac7e1-2eb4-4f13-b844-0e14e2aef915': 'Linux Home',
    '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f': 'Linux Swap',
    'e6d6d379-f507-44c2-a23c-238f2a3df928': 'Linux LVM',
    'a19d880f-05fc-4d3b-a006-743f0f84911e': 'Linux RAID',
    'ca7d7ccb-63ed-4c53-861c-1742536059cc': 'Linux LUKS',
    'bc13c2ff-59e6-4262-a352-b275fd6f7172': 'Linux Extended Boot',
    '21686148-6449-6e6f-744e-656564454649': 'BIOS Boot',
    'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7': 'Microsoft Basic Data',
    'e3c9e316-0b5c-4db8-817d-f92df00215ae': 'Microsoft Reserved',
    'de94bba4-06d1-4d40-a16a-bfd50179d6ac': 'Windows Recovery',
    '7c3457ef-0000-11aa-aa11-00306543ecac': 'Apple APFS',
    '48465300-0000-11aa-aa11-00306543ecac': 'Apple HFS+',
    '0x83': 'Linux', '0x82': 'Linux Swap', '0x07': 'NTFS / exFAT', '0x0c': 'FAT32 (LBA)', '0x0b': 'FAT32', '0xef': 'EFI System',
};

const FS_NAMES = {
    btrfs: 'Btrfs', ext2: 'ext2', ext3: 'ext3', ext4: 'ext4', xfs: 'XFS', vfat: 'FAT', exfat: 'ExFAT',
    ntfs: 'NTFS', f2fs: 'F2FS', swap: 'Swap', crypto_LUKS: 'LUKS', iso9660: 'ISO 9660', udf: 'UDF',
    apfs: 'APFS', hfsplus: 'Mac OS Extended', squashfs: 'SquashFS',
};

// ---- helpers ----------------------------------------------------------------

function str(v) {
    if (v instanceof Uint8Array)
        return new TextDecoder().decode(v).replace(/\0+$/, '');
    return v ?? '';
}

function formatSize(bytes) {
    if (bytes === null || bytes === undefined || Number.isNaN(bytes))
        return '—';
    if (bytes < 1000)
        return `${bytes} bytes`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes, i = -1;
    do {
        v /= 1000;
        i++;
    } while (v >= 1000 && i < units.length - 1);
    return `${v.toFixed(2)} ${units[i]}`;
}

const VENDORS = ['KIOXIA', 'SAMSUNG', 'WDC', 'WD', 'SanDisk', 'Crucial', 'INTEL', 'SK hynix', 'SKHynix', 'Micron',
    'Seagate', 'ST', 'TOSHIBA', 'Kingston', 'Lexar', 'ADATA', 'Transcend', 'Sabrent', 'APPLE', 'HGST', 'Hitachi', 'Corsair', 'PNY', 'Verbatim'];

// "KXG80ZNV1T02 NVMe KIOXIA 1024GB" → "KIOXIA KXG80ZNV1T02"
function prettyModel(vendor, model) {
    let words = (model || '').split(/[\s_]+/).filter(w => w);
    words = words.filter(w => !/^\d+(\.\d+)?\s*(GB|TB|G|T)$/i.test(w) && !/^NVMe$/i.test(w));
    let brand = vendor?.trim();
    if (!brand) {
        const i = words.findIndex(w => VENDORS.some(v => v.toLowerCase() === w.toLowerCase()));
        if (i >= 0)
            brand = words.splice(i, 1)[0];
    }
    const rest = words.filter(w => w.toLowerCase() !== brand?.toLowerCase()).join(' ');
    return [brand, rest].filter(x => x).join(' ') || 'Unknown Drive';
}

function fsName(type, version) {
    const name = FS_NAMES[type] ?? (type || 'Unknown');
    if (type === 'vfat' && version)
        return version; // "FAT32"
    return name;
}

function devName(path) {
    return path ? path.replace(/^\/dev\//, '') : '';
}

function readLink(path) {
    try {
        const target = GLib.file_read_link(path);
        return GLib.canonicalize_filename(target, GLib.path_get_dirname(path));
    } catch (e) {
        return path;
    }
}

function osName() {
    try {
        const text = new TextDecoder().decode(GLib.file_get_contents('/etc/os-release')[1]);
        return text.match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? '';
    } catch (e) {
        return '';
    }
}

function readMountInfo() {
    const mounts = [];
    try {
        const text = new TextDecoder().decode(GLib.file_get_contents('/proc/self/mountinfo')[1]);
        const unescape = s => s.replace(/\\(\d{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
        for (const line of text.split('\n')) {
            if (!line)
                continue;
            const parts = line.split(' ');
            const sep = parts.indexOf('-');
            mounts.push({
                root: unescape(parts[3]),
                mountPoint: unescape(parts[4]),
                options: parts[5],
                fsType: parts[sep + 1],
                source: parts[sep + 2],
                superOptions: parts[sep + 3] ?? '',
            });
        }
    } catch (e) {
        console.warn(`Disk Utility: can't read mountinfo: ${e.message}`);
    }
    return mounts;
}

async function filesystemUsage(mountPoint) {
    try {
        const info = await Gio.File.new_for_path(mountPoint).query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used,filesystem::readonly',
            GLib.PRIORITY_DEFAULT, null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        const used = info.has_attribute('filesystem::used')
            ? info.get_attribute_uint64('filesystem::used') : size - free;
        return {size, free, used, readonly: info.get_attribute_boolean('filesystem::readonly')};
    } catch (e) {
        return null;
    }
}

async function udisksCall(path, iface, method, params, replyType = null) {
    return Gio.DBus.system.call(UD, path, I(iface), method, params,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, -1, null);
}

const NO_OPTIONS = () => new GLib.Variant('(a{sv})', [{}]);

// DU_DEMO=1 shows made-up disks instead of the real ones (for screenshots and development).
const DEMO = !!GLib.getenv('DU_DEMO');

async function systemSource() {
    const reply = await Gio.DBus.system.call(UD, '/org/freedesktop/UDisks2',
        'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null, null,
        Gio.DBusCallFlags.NONE, -1, null);
    return {
        objects: reply.recursiveUnpack()[0],
        mountInfo: readMountInfo(),
        usage: filesystemUsage,
        os: osName(),
    };
}

// ---- model ------------------------------------------------------------------
//
// Node kinds: drive, container (LUKS), group (Btrfs with subvolumes),
// subvolume, volume (plain filesystem), swap, other (unrecognised partition),
// image (loop device).

async function loadModel() {
    const source = DEMO ? (await import('./demo.js')).demoSource() : await systemSource();
    const {objects, mountInfo} = source;

    const blocks = new Map();
    const drives = new Map();
    const byDevice = new Map();
    for (const [path, ifaces] of Object.entries(objects)) {
        if (ifaces[I('Drive')]) {
            drives.set(path, {path, ifaces});
        } else if (ifaces[I('Block')]) {
            const b = {path, ifaces, block: ifaces[I('Block')]};
            b.device = str(b.block.Device);
            b.preferred = str(b.block.PreferredDevice);
            blocks.set(path, b);
            byDevice.set(b.device, b);
            byDevice.set(b.preferred, b);
        }
    }

    const mountsFor = b => mountInfo.filter(m => {
        if (!m.source.startsWith('/dev/'))
            return false;
        const dev = byDevice.get(m.source) ?? byDevice.get(readLink(m.source));
        return dev === b;
    });

    const os = source.os;
    let seq = 0;

    const makeNode = (props, parent) => {
        const node = {children: [], parent, index: seq++, ...props};
        if (parent)
            parent.children.push(node);
        return node;
    };

    const contentNode = (b, parent, partitionInfo = null) => {
        const {block} = b;
        const usage = block.IdUsage;
        const type = block.IdType;
        const label = block.IdLabel;
        const partName = partitionInfo?.Name;
        const baseName = label || partName;
        const common = {
            b,
            size: block.Size,
            device: b.device,
            partition: partitionInfo,
            system: block.HintSystem,
        };

        if (usage === 'crypto') {
            const enc = b.ifaces[I('Encrypted')] ?? {};
            const clearPath = enc.CleartextDevice && enc.CleartextDevice !== '/' ? enc.CleartextDevice : null;
            const node = makeNode({
                ...common,
                id: b.path,
                kind: 'container',
                name: `Container ${devName(b.device)}`,
                title: baseName || 'Encrypted Container',
                locked: !clearPath,
                encryption: `${type === 'crypto_LUKS' ? 'LUKS' : type}${block.IdVersion ? block.IdVersion : ''}`,
                enc,
            }, parent);
            if (clearPath && blocks.has(clearPath))
                contentNode(blocks.get(clearPath), node);
            return node;
        }

        const mounts = mountsFor(b);
        const fs = b.ifaces[I('Filesystem')];
        const encrypted = block.CryptoBackingDevice && block.CryptoBackingDevice !== '/';

        if (type === 'btrfs') {
            const subvols = mounts.filter(m => m.root && m.root !== '/');
            if (subvols.length > 0) {
                const group = makeNode({
                    ...common,
                    id: b.path,
                    kind: 'group',
                    name: baseName || 'Btrfs Volume Group',
                    secondary: 'volumes',
                    fsType: type,
                    fsVersion: block.IdVersion,
                    uuid: block.IdUUID,
                    encrypted,
                    mounts,
                }, parent);
                const byRoot = new Map();
                for (const m of subvols) {
                    if (!byRoot.has(m.root))
                        byRoot.set(m.root, []);
                    byRoot.get(m.root).push(m);
                }
                for (const [root, ms] of byRoot) {
                    const primary = ms.find(m => m.mountPoint === '/') ?? ms[0];
                    makeNode({
                        ...common,
                        id: `${b.path}#${root}`,
                        kind: 'subvolume',
                        name: root.replace(/^\//, '') || root,
                        subvolume: root,
                        subvolId: primary.options.match(/subvolid=(\d+)/)?.[1] ??
                            primary.superOptions.match(/subvolid=(\d+)/)?.[1],
                        mountPoints: ms.map(m => m.mountPoint),
                        mountOptions: primary.superOptions,
                        osName: ms.some(m => m.mountPoint === '/') ? os : '',
                        fsType: type,
                        uuid: block.IdUUID,
                        encrypted,
                    }, group);
                }
                return group;
            }
        }

        if (usage === 'filesystem' || fs) {
            const mountPoints = fs ? fs.MountPoints.map(str) : mounts.map(m => m.mountPoint);
            const fallback = mountPoints[0] && mountPoints[0] !== '/' ? GLib.path_get_basename(mountPoints[0]) : null;
            return makeNode({
                ...common,
                id: b.path,
                kind: 'volume',
                name: baseName || fallback || (mountPoints[0] === '/' ? 'root' : `${fsName(type, block.IdVersion)} Volume`),
                fsType: type,
                fsVersion: block.IdVersion,
                uuid: block.IdUUID,
                label,
                mountPoints,
                osName: mountPoints.includes('/') ? os : '',
                encrypted,
                canMount: !!fs,
            }, parent);
        }

        if (type === 'swap' || b.ifaces[I('Swapspace')]) {
            return makeNode({
                ...common,
                id: b.path,
                kind: 'swap',
                name: baseName || 'Swap',
                fsType: 'swap',
                uuid: block.IdUUID,
                active: b.ifaces[I('Swapspace')]?.Active,
            }, parent);
        }

        return makeNode({
            ...common,
            id: b.path,
            kind: 'other',
            name: partName || (partitionInfo ? `Partition ${partitionInfo.Number}` : devName(b.device)),
            fsType: type,
        }, parent);
    };

    const sections = {internal: [], external: [], images: []};

    for (const d of drives.values()) {
        const drive = d.ifaces[I('Drive')];
        const whole = [...blocks.values()].find(b => b.block.Drive === d.path && !b.ifaces[I('Partition')]);
        const nvme = d.ifaces[I('NVMe.Controller')];
        const ata = d.ifaces[I('Drive.Ata')];
        const external = drive.Removable || drive.MediaRemovable || drive.ConnectionBus === 'usb' ||
            drive.ConnectionBus === 'sdio' || drive.ConnectionBus === 'ieee1394';
        const model = prettyModel(drive.Vendor, drive.Model);
        const node = makeNode({
            id: d.path,
            kind: 'drive',
            name: `${model} Media`,
            title: model,
            b: whole,
            drive,
            nvme,
            ata,
            driveIfaces: d.ifaces,
            size: drive.Size,
            device: whole?.device ?? '',
            external,
            system: whole?.block.HintSystem,
            rotational: drive.RotationRate !== 0 && drive.RotationRate !== undefined && !nvme,
        }, null);
        if (whole) {
            const table = whole.ifaces[I('PartitionTable')];
            node.tableType = table?.Type;
            if (table) {
                const parts = [...blocks.values()]
                    .filter(b => b.ifaces[I('Partition')]?.Table === whole.path)
                    .sort((a, c) => a.ifaces[I('Partition')].Offset - c.ifaces[I('Partition')].Offset);
                for (const p of parts)
                    contentNode(p, node, p.ifaces[I('Partition')]);
            } else if (whole.block.IdUsage) {
                contentNode(whole, node);
            }
        }
        (external ? sections.external : sections.internal).push(node);
    }

    for (const b of blocks.values()) {
        const loop = b.ifaces[I('Loop')];
        if (!loop || b.block.HintIgnore || !b.block.Size)
            continue;
        const backing = str(loop.BackingFile);
        if (!backing || backing.startsWith('/var/lib/snapd/'))
            continue;
        const node = makeNode({
            id: b.path,
            kind: 'image',
            name: GLib.path_get_basename(backing),
            b,
            size: b.block.Size,
            device: b.device,
            backing,
            system: false,
        }, null);
        const table = b.ifaces[I('PartitionTable')];
        if (table) {
            const parts = [...blocks.values()].filter(p => p.ifaces[I('Partition')]?.Table === b.path);
            for (const p of parts)
                contentNode(p, node, p.ifaces[I('Partition')]);
        } else if (b.block.IdUsage) {
            contentNode(b, node);
        }
        sections.images.push(node);
    }

    const byId = new Map();
    const walk = n => {
        byId.set(n.id, n);
        n.children.forEach(walk);
    };
    Object.values(sections).flat().forEach(walk);

    // Filesystem usage for everything that's mounted.
    await Promise.all([...byId.values()].map(async n => {
        const mp = n.mountPoints?.[0] ?? n.mounts?.[0]?.mountPoint;
        if (mp)
            n.usage = await source.usage(mp);
    }));

    return {sections, byId};
}

// ---- detail description -----------------------------------------------------

function describe(node) {
    const d = {title: node.title ?? node.name, subtitle: '', line3: '', sizeText: formatSize(node.size),
        sizeCaption: '', segments: [], info: [], icon: 'volume'};
    const partType = node.partition ? PARTITION_TYPES[node.partition.Type?.toLowerCase()] ?? node.partition.Type : null;
    const mountLabel = u => (u?.readonly ? 'Mount Point (Read-Only)' : 'Mount Point');
    const usageSegments = (u, usedLabel = 'Used') => u
        ? [{label: usedLabel, size: u.used, color: COLORS.used}, {label: 'Free', size: u.free, color: null}]
        : [{label: 'Not Mounted', size: node.size, color: COLORS.other}];

    switch (node.kind) {
    case 'drive': {
        const drv = node.drive;
        const bus = node.nvme ? 'PCI Express (NVMe)' : {usb: 'USB', sdio: 'SD Card', ieee1394: 'FireWire', '': 'SATA'}[drv.ConnectionBus] ?? drv.ConnectionBus;
        const kind = node.nvme || drv.RotationRate === 0 ? 'Solid State' : 'Rotational';
        const map = {gpt: 'GUID Partition Map', dos: 'Master Boot Record'}[node.tableType] ?? (node.tableType ? node.tableType : 'No Partition Map');
        d.icon = node.external ? 'drive-external' : 'drive';
        d.subtitle = `${node.nvme ? 'NVMe' : bus} ${node.external ? 'External' : 'Internal'} Physical Disk • ${map}`;
        d.line3 = drv.Serial ? `Serial number ${drv.Serial}` : '';
        d.sizeCaption = kind.toUpperCase();
        let allocated = 0;
        node.children.forEach((c, i) => {
            const size = c.partition?.Size ?? c.size;
            allocated += size;
            d.segments.push({label: c.title && c.kind === 'container' ? c.name : c.name, size, color: COLORS.partitions[i % COLORS.partitions.length]});
        });
        const unallocated = node.size - allocated;
        if (unallocated > Math.max(16e6, node.size * 0.001))
            d.segments.push({label: 'Free', size: unallocated, color: null});
        d.info = [
            ['Location', node.external ? 'External' : 'Internal'],
            ['Capacity', formatSize(node.size)],
            ['Child count', String(node.children.length)],
            ['Type', kind === 'Solid State' ? 'Solid State Disk' : 'Hard Disk'],
            ['Firmware', drv.Revision],
            ['Connection', bus],
            ['Partition Map', map],
            ['S.M.A.R.T. status', smartStatus(node)],
            ['Device', devName(node.device)],
            ['Model', drv.Model],
        ];
        break;
    }
    case 'container': {
        const clear = node.children[0];
        d.icon = 'container';
        d.title = node.title;
        d.subtitle = `${node.encryption} Encrypted Container • ${node.locked ? 'Locked' : 'Unlocked'}`;
        d.line3 = partType ? `${partType} partition` : '';
        d.sizeCaption = node.locked ? 'LOCKED' : 'ENCRYPTED';
        const meta = Number(node.enc.MetadataSize) || 0;
        if (clear) {
            d.segments = [
                {label: clear.name, size: clear.size, color: COLORS.used},
                {label: 'Encryption Header', size: meta || node.size - clear.size, color: COLORS.other},
            ];
        } else {
            d.segments = [{label: 'Locked', size: node.size, color: COLORS.other}];
        }
        d.info = [
            ['Capacity', formatSize(node.size)],
            ['Encryption', node.encryption],
            ['Status', node.locked ? 'Locked' : 'Unlocked'],
            ['Header Size', meta ? formatSize(meta) : '—'],
            ['Partition Type', partType ?? '—'],
            ['Device', devName(node.device)],
            ['Unlocked As', clear ? devName(clear.device) : '—'],
            ['Contents', clear ? `${fsName(clear.fsType)} ${clear.kind === 'group' ? 'Volume Group' : 'Volume'}` : '—'],
            ['UUID', node.b.block.IdUUID],
            ['Partition UUID', node.partition?.UUID ?? '—'],
        ];
        break;
    }
    case 'group': {
        const u = node.usage;
        d.icon = 'group';
        d.subtitle = `Btrfs Volume Group${node.encrypted ? ' • Encrypted' : ''}`;
        d.line3 = node.b.block.IdLabel ? `Label ${node.b.block.IdLabel}` : '';
        d.sizeText = formatSize(u?.size ?? node.size);
        d.sizeCaption = `SHARED BY ${node.children.length} VOLUME${node.children.length === 1 ? '' : 'S'}`;
        d.segments = usageSegments(u);
        d.info = [
            ['Capacity', formatSize(u?.size ?? node.size)],
            ['Available', formatSize(u?.free)],
            ['Used', formatSize(u?.used)],
            ['Volumes', node.children.map(c => c.name).join(', ')],
            ['Mount Points', [...new Set(node.mounts.map(m => m.mountPoint))].join(', ')],
            ['Type', 'Btrfs Volume Group'],
            ['Encrypted', node.encrypted ? 'Yes' : 'No'],
            ['Compression', node.mounts[0]?.superOptions.match(/compress(?:-force)?=([^,]+)/)?.[1] ?? 'None'],
            ['Device', devName(node.device)],
            ['UUID', node.uuid],
        ];
        break;
    }
    case 'subvolume': {
        const u = node.usage;
        const others = node.parent.children.filter(c => c !== node).map(c => c.name);
        d.icon = 'volume';
        d.subtitle = `Btrfs Volume${node.encrypted ? ' • Encrypted' : ''}`;
        d.line3 = node.osName;
        d.sizeText = formatSize(u?.size ?? node.size);
        d.sizeCaption = `SHARED BY ${node.parent.children.length} VOLUMES`;
        d.segments = usageSegments(u, 'Used (all volumes)');
        d.info = [
            [mountLabel(u), node.mountPoints.join(', ')],
            ['Capacity', formatSize(u?.size)],
            ['Available', formatSize(u?.free)],
            ['Used', formatSize(u?.used)],
            ['Subvolume', node.subvolume],
            ['Type', 'Btrfs Volume'],
            ['Shared With', others.join(', ') || '—'],
            ['Subvolume ID', node.subvolId ?? '—'],
            ['Device', devName(node.device)],
            ['UUID', node.uuid],
        ];
        break;
    }
    case 'volume': {
        const u = node.usage;
        const fsn = fsName(node.fsType, node.fsVersion);
        d.icon = 'volume';
        d.subtitle = `${fsn} Volume${partType ? ` • ${partType}` : ''}${node.encrypted ? ' • Encrypted' : ''}`;
        d.line3 = node.osName;
        d.sizeCaption = node.mountPoints.length ? 'MOUNTED' : 'NOT MOUNTED';
        d.segments = usageSegments(u);
        d.info = [
            [mountLabel(u), node.mountPoints.join(', ') || 'Not mounted'],
            ['Capacity', formatSize(node.size)],
            ['Available', formatSize(u?.free)],
            ['Used', formatSize(u?.used)],
            ['Label', node.label || '—'],
            ['Type', `${fsn} Volume`],
            ['Partition Type', partType ?? '—'],
            ['Encrypted', node.encrypted ? 'Yes' : 'No'],
            ['Device', devName(node.device)],
            ['UUID', node.uuid || '—'],
        ];
        break;
    }
    case 'swap':
        d.icon = 'volume';
        d.subtitle = `Swap Space${partType ? ` • ${partType}` : ''}`;
        d.sizeCaption = node.active ? 'IN USE' : 'INACTIVE';
        d.segments = [{label: 'Swap', size: node.size, color: COLORS.other}];
        d.info = [['Capacity', formatSize(node.size)], ['Status', node.active ? 'Active' : 'Inactive'],
            ['Device', devName(node.device)], ['UUID', node.uuid || '—']];
        break;
    case 'image':
        d.icon = 'image';
        d.subtitle = 'Disk Image';
        d.line3 = node.backing;
        d.sizeCaption = 'DISK IMAGE';
        d.segments = node.children.map((c, i) => ({label: c.name, size: c.size, color: COLORS.partitions[i % 8]}));
        d.info = [['Image File', node.backing], ['Capacity', formatSize(node.size)], ['Device', devName(node.device)]];
        break;
    default:
        d.icon = 'volume';
        d.subtitle = `${node.fsType ? fsName(node.fsType) : 'Unformatted'} Partition${partType ? ` • ${partType}` : ''}`;
        d.sizeCaption = 'PARTITION';
        d.segments = [{label: node.name, size: node.size, color: COLORS.other}];
        d.info = [['Capacity', formatSize(node.size)], ['Partition Type', partType ?? '—'],
            ['Device', devName(node.device)], ['Partition UUID', node.partition?.UUID ?? '—']];
    }
    return d;
}

function smartStatus(node) {
    if (node.nvme) {
        const warnings = node.nvme.SmartCriticalWarning ?? [];
        if (!node.nvme.SmartUpdated)
            return 'Not Supported';
        return warnings.length ? `Failing (${warnings.join(', ')})` : 'Verified';
    }
    if (node.ata) {
        if (!node.ata.SmartSupported)
            return 'Not Supported';
        if (!node.ata.SmartEnabled)
            return 'Disabled';
        return node.ata.SmartFailing ? 'Failing' : 'Verified';
    }
    return 'Not Supported';
}

// ---- widgets ----------------------------------------------------------------

function hexToRgba(hex, alpha = 1) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    rgba.alpha = alpha;
    return rgba;
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function usageBar(segments) {
    const area = new Gtk.DrawingArea({content_height: 24, hexpand: true, css_classes: ['du-bar']});
    area.set_draw_func((widget, cr, width, height) => {
        const fg = widget.get_color();
        const total = segments.reduce((s, seg) => s + Math.max(0, seg.size || 0), 0) || 1;
        const radius = 5;
        // Tiny partitions still get a visible sliver, like macOS.
        const minW = 5;
        let widths = segments.map(seg => (Math.max(0, seg.size || 0) / total) * width);
        const small = widths.filter(w => w > 0 && w < minW).length;
        const bigTotal = widths.filter(w => w >= minW).reduce((a, b) => a + b, 0);
        if (small && bigTotal > 0) {
            const scale = (width - small * minW) / bigTotal;
            widths = widths.map(w => (w > 0 && w < minW ? minW : w * scale));
        }
        roundedRect(cr, 0.5, 0.5, width - 1, height - 1, radius);
        cr.save();
        cr.clip();
        let x = 0;
        segments.forEach((seg, i) => {
            const w = widths[i];
            if (seg.color) {
                const c = hexToRgba(seg.color);
                cr.setSourceRGBA(c.red, c.green, c.blue, 1);
                cr.rectangle(x, 0, w, height);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.rectangle(x + w - 0.5, 0, 1, height);
                cr.fill();
            }
            x += w;
        });
        cr.restore();
        roundedRect(cr, 0.5, 0.5, width - 1, height - 1, radius);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.22);
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

function swatch(color) {
    const area = new Gtk.DrawingArea({content_width: 11, content_height: 11, valign: Gtk.Align.CENTER});
    area.set_draw_func((widget, cr, w, h) => {
        const fg = widget.get_color();
        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, 2.5);
        if (color) {
            const c = hexToRgba(color);
            cr.setSourceRGBA(c.red, c.green, c.blue, 1);
            cr.fillPreserve();
        }
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, color ? 0 : 0.35);
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

function label(text, classes = [], props = {}) {
    return new Gtk.Label({label: text ?? '', xalign: 0, css_classes: classes, ...props});
}

function toolButton(icon, text, tooltip) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 1});
    const image = icon.startsWith('du-')
        ? new Gtk.Image({gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${DIR}/icons/${icon}.svg`)), pixel_size: 16})
        : new Gtk.Image({icon_name: icon, pixel_size: 16});
    box.append(image);
    box.append(new Gtk.Label({label: text, css_classes: ['du-tool-label']}));
    return new Gtk.Button({child: box, css_classes: ['flat', 'du-tool'], tooltip_text: tooltip ?? text});
}

function sidebarIcon(node) {
    const names = {
        drive: node.external ? 'drive-removable-media-symbolic' : 'drive-harddisk-solidstate-symbolic',
        container: 'package-x-generic-symbolic',
        group: 'du-group-symbolic',
        image: 'media-optical-symbolic',
    };
    const name = names[node.kind] ?? (node.kind === 'drive' && node.rotational ? 'drive-harddisk-symbolic' : 'drive-harddisk-symbolic');
    if (name.startsWith('du-'))
        return new Gtk.Image({gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${DIR}/icons/${name}.svg`)), css_classes: ['du-row-icon']});
    return new Gtk.Image({icon_name: name, css_classes: ['du-row-icon']});
}

// ---- window -----------------------------------------------------------------

class DiskUtilityWindow {
    constructor(app) {
        this.app = app;
        this.expanded = new Map();
        this.selectedId = null;
        this.showAll = true;
        this.model = null;

        this.window = new Adw.ApplicationWindow({
            application: app,
            title: 'Disk Utility',
            default_width: 1000,
            default_height: 640,
            width_request: 720,
            height_request: 460,
        });

        // Sidebar
        this.list = new Gtk.ListBox({css_classes: ['du-sidebar-list', 'navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
        this.list.connect('row-selected', (lb, row) => {
            if (row?._node && !this._rendering) {
                this.selectedId = row._node.id;
                this.showDetail(row._node);
            }
        });
        const sidebarHeader = new Adw.HeaderBar({show_title: false, css_classes: ['du-sidebar-header']});
        const sidebarView = new Adw.ToolbarView();
        sidebarView.add_top_bar(sidebarHeader);
        sidebarView.set_content(new Gtk.ScrolledWindow({child: this.list, hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true}));

        // Content
        const header = new Adw.HeaderBar({show_title: false, css_classes: ['du-content-header']});
        header.pack_start(this.buildViewButton());
        header.pack_start(new Gtk.Label({label: 'Disk Utility', css_classes: ['du-app-title']}));

        this.buttons = {
            info: toolButton('dialog-information-symbolic', 'Info', 'Show all information about the selected item'),
            mount: toolButton('media-eject-symbolic', 'Unmount'),
            restore: toolButton('document-revert-symbolic', 'Restore', 'Restore (opens GNOME Disks)'),
            erase: toolButton('edit-clear-all-symbolic', 'Erase', 'Erase (opens GNOME Disks)'),
            partition: toolButton('du-partition-symbolic', 'Partition', 'Partition (opens GNOME Disks)'),
            firstAid: toolButton('du-firstaid-symbolic', 'First Aid', 'Check the health of the selected item'),
        };
        const volBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 1, css_classes: ['du-volume-tool']});
        const volIcons = new Gtk.Box({spacing: 10, halign: Gtk.Align.CENTER});
        volIcons.append(new Gtk.Image({icon_name: 'list-add-symbolic', pixel_size: 14}));
        volIcons.append(new Gtk.Image({icon_name: 'list-remove-symbolic', pixel_size: 14}));
        volBox.append(volIcons);
        volBox.append(new Gtk.Label({label: 'Volume', css_classes: ['du-tool-label']}));
        this.buttons.volume = new Gtk.Button({child: volBox, css_classes: ['flat', 'du-tool'], sensitive: false,
            tooltip_text: 'Adding and removing Btrfs volumes needs administrator rights'});
        for (const key of ['info', 'mount', 'restore', 'erase', 'partition', 'firstAid', 'volume'])
            header.pack_end(this.buttons[key]);

        this.buttons.info.connect('clicked', () => this.showInfo());
        this.buttons.firstAid.connect('clicked', () => this.firstAid());
        this.buttons.mount.connect('clicked', () => this.mountAction());
        for (const key of ['restore', 'erase', 'partition'])
            this.buttons[key].connect('clicked', () => this.openInDisks());

        this.detail = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, css_classes: ['du-detail']});
        const contentView = new Adw.ToolbarView();
        contentView.add_top_bar(header);
        contentView.set_content(new Gtk.ScrolledWindow({child: this.detail, vexpand: true, css_classes: ['du-content']}));

        this.split = new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({title: 'Devices', child: sidebarView}),
            content: new Adw.NavigationPage({title: 'Disk Utility', child: contentView}),
            min_sidebar_width: 240,
            max_sidebar_width: 320,
            sidebar_width_fraction: 0.28,
        });
        this.window.set_content(this.split);

        this.watchChanges();
        this.reload();
    }

    buildViewButton() {
        const action = new Gio.SimpleAction({
            name: 'view-mode',
            parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s', 'all'),
        });
        action.connect('activate', (a, param) => {
            a.set_state(param);
            this.showAll = param.unpack() === 'all';
            this.renderSidebar();
        });
        this.window.add_action(action);
        const menu = new Gio.Menu();
        menu.append('Show Only Volumes', 'win.view-mode::volumes');
        menu.append('Show All Devices', 'win.view-mode::all');
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 1});
        const icons = new Gtk.Box({spacing: 2, halign: Gtk.Align.CENTER});
        icons.append(new Gtk.Image({icon_name: 'sidebar-show-symbolic', pixel_size: 16}));
        icons.append(new Gtk.Image({icon_name: 'pan-down-symbolic', pixel_size: 10}));
        box.append(icons);
        box.append(new Gtk.Label({label: 'View', css_classes: ['du-tool-label']}));
        return new Gtk.MenuButton({child: box, menu_model: menu, css_classes: ['flat', 'du-tool'], tooltip_text: 'View'});
    }

    watchChanges() {
        const queue = () => {
            if (this._reloadId)
                GLib.source_remove(this._reloadId);
            this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._reloadId = 0;
                this.reload();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._signalId = Gio.DBus.system.signal_subscribe(UD, null, null, null, null,
            Gio.DBusSignalFlags.NONE, queue);
        this.window.connect('close-request', () => {
            Gio.DBus.system.signal_unsubscribe(this._signalId);
            return false;
        });
    }

    async reload() {
        try {
            this.model = await loadModel();
        } catch (e) {
            this.showError('Could not read disks', `${e.message}\n\nIs the UDisks2 service running?`);
            return;
        }
        this.renderSidebar();
        const wanted = !this.selectedId && GLib.getenv('DU_SELECT');
        const preselect = wanted ? [...this.model.byId.values()].find(n => n.id.includes(wanted) || n.name.includes(wanted)) : null;
        const node = preselect ?? this.model.byId.get(this.selectedId) ?? this.firstNode();
        if (node) {
            this.selectedId = node.id;
            this.selectRow(node.id);
            this.showDetail(node);
        }
    }

    firstNode() {
        const {sections} = this.model;
        return sections.internal[0] ?? sections.external[0] ?? sections.images[0];
    }

    renderSidebar() {
        if (!this.model)
            return;
        this._rendering = true;
        this.list.remove_all();
        const addSection = (title, nodes) => {
            if (!nodes.length)
                return;
            const header = new Gtk.ListBoxRow({selectable: false, activatable: false, child: label(title, ['du-section'])});
            this.list.append(header);
            if (this.showAll) {
                nodes.forEach(n => this.addRow(n, 0));
            } else {
                const volumes = [];
                const walk = n => {
                    if (['volume', 'subvolume', 'swap'].includes(n.kind))
                        volumes.push(n);
                    n.children.forEach(walk);
                };
                nodes.forEach(walk);
                volumes.forEach(v => this.addRow(v, 0, true));
            }
        };
        addSection('Internal', this.model.sections.internal);
        addSection('External', this.model.sections.external);
        addSection('Disk Images', this.model.sections.images);
        this._rendering = false;
        this.selectRow(this.selectedId);
    }

    addRow(node, depth, flat = false) {
        const box = new Gtk.Box({spacing: 6, margin_start: 4 + depth * 16, css_classes: ['du-row']});
        const hasChildren = !flat && node.children.length > 0;
        const expanded = this.expanded.get(node.id) ?? true;
        if (hasChildren) {
            const toggle = new Gtk.Button({
                icon_name: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
                css_classes: ['flat', 'du-disclosure'],
                valign: Gtk.Align.CENTER,
            });
            toggle.connect('clicked', () => {
                this.expanded.set(node.id, !expanded);
                this.renderSidebar();
            });
            box.append(toggle);
        } else {
            box.append(new Gtk.Box({width_request: 18}));
        }
        box.append(sidebarIcon(node));
        const name = label(node.name, ['du-row-name'], {ellipsize: Pango.EllipsizeMode.END});
        box.append(name);
        if (node.secondary)
            box.append(label(node.secondary, ['du-dim'], {hexpand: false}));
        if (node.kind === 'container' && node.locked)
            box.append(new Gtk.Image({icon_name: 'system-lock-screen-symbolic', pixel_size: 12, css_classes: ['du-dim']}));
        const dimmed = ['volume', 'subvolume'].includes(node.kind) && node.usage === undefined && !node.mountPoints?.length;
        if (dimmed)
            box.add_css_class('du-unmounted');
        const row = new Gtk.ListBoxRow({child: box});
        row._node = node;
        this.list.append(row);
        if (hasChildren && expanded)
            node.children.forEach(c => this.addRow(c, depth + 1));
    }

    selectRow(id) {
        for (let row = this.list.get_first_child(); row; row = row.get_next_sibling()) {
            if (row._node?.id === id) {
                this._rendering = true;
                this.list.select_row(row);
                this._rendering = false;
                return;
            }
        }
    }

    showDetail(node) {
        this.current = node;
        let child;
        while ((child = this.detail.get_first_child()))
            this.detail.remove(child);
        const d = describe(node);

        // Header: icon, names, size box
        const top = new Gtk.Box({spacing: 16});
        top.append(Gtk.Image.new_from_file(`${DIR}/icons/${d.icon}.svg`));
        top.get_first_child().pixel_size = 72;
        const names = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.CENTER, hexpand: true});
        names.append(label(d.title, ['du-title'], {ellipsize: Pango.EllipsizeMode.END, selectable: true}));
        names.append(label(d.subtitle, ['du-subtitle'], {wrap: true}));
        if (d.line3)
            names.append(label(d.line3, ['du-line3'], {ellipsize: Pango.EllipsizeMode.MIDDLE}));
        top.append(names);
        const sizeBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 3, valign: Gtk.Align.CENTER});
        const frame = new Gtk.Box({css_classes: ['du-sizebox'], halign: Gtk.Align.CENTER});
        frame.append(new Gtk.Label({label: d.sizeText, css_classes: ['du-size']}));
        sizeBox.append(frame);
        if (d.sizeCaption)
            sizeBox.append(new Gtk.Label({label: d.sizeCaption, css_classes: ['du-sizecap']}));
        top.append(sizeBox);
        this.detail.append(top);
        this.detail.append(new Gtk.Separator({css_classes: ['du-sep']}));

        // Usage bar + legend
        this.detail.append(usageBar(d.segments));
        const legend = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 4,
            min_children_per_line: Math.min(4, Math.max(1, d.segments.length)),
            homogeneous: true,
            column_spacing: 12,
            row_spacing: 10,
            css_classes: ['du-legend'],
        });
        for (const seg of d.segments) {
            const item = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 3});
            const head = new Gtk.Box({spacing: 6});
            head.append(swatch(seg.color));
            head.append(label(seg.label, ['du-legend-name'], {ellipsize: Pango.EllipsizeMode.END}));
            item.append(head);
            item.append(label(formatSize(seg.size), ['du-legend-size'], {margin_start: 17}));
            legend.append(item);
        }
        this.detail.append(legend);

        // Info table: two columns
        const table = new Gtk.Box({homogeneous: true, css_classes: ['du-info']});
        const half = Math.ceil(d.info.length / 2);
        for (const rows of [d.info.slice(0, half), d.info.slice(half)]) {
            const col = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['du-info-col']});
            for (const [key, value] of rows) {
                const row = new Gtk.Box({spacing: 12, css_classes: ['du-info-row']});
                row.append(label(`${key}:`, ['du-info-key']));
                row.append(label(value || '—', ['du-info-value'], {
                    hexpand: true, xalign: 1, selectable: true, ellipsize: Pango.EllipsizeMode.MIDDLE,
                    tooltip_text: value || null,
                }));
                col.append(row);
            }
            table.append(col);
        }
        this.detail.append(table);

        this.updateButtons(node);
    }

    updateButtons(node) {
        const b = this.buttons;
        const system = !!node.system;
        const mounted = node.mountPoints?.length > 0;
        let mountLabel = 'Unmount', mountIcon = 'media-eject-symbolic', mountEnabled = false, mountTip = '';

        if (node.kind === 'drive' && node.external) {
            mountLabel = 'Eject';
            mountEnabled = true;
        } else if (node.kind === 'container' && node.locked) {
            mountLabel = 'Unlock';
            mountIcon = 'system-lock-screen-symbolic';
            mountEnabled = !system;
        } else if (node.kind === 'container') {
            mountLabel = 'Lock';
            mountIcon = 'system-lock-screen-symbolic';
            mountEnabled = !system;
        } else if (node.kind === 'volume' && node.canMount) {
            mountLabel = mounted ? 'Unmount' : 'Mount';
            mountIcon = mounted ? 'media-eject-symbolic' : 'drive-harddisk-symbolic';
            mountEnabled = !system;
        }
        if (system && ['volume', 'subvolume', 'container', 'group'].includes(node.kind))
            mountTip = 'This volume is in use by the running system';
        b.mount.get_child().get_first_child().icon_name = mountIcon;
        b.mount.get_child().get_last_child().label = mountLabel;
        b.mount.sensitive = mountEnabled;
        b.mount.tooltip_text = mountTip || mountLabel;

        const modifiable = !system && ['drive', 'volume', 'other', 'container', 'image'].includes(node.kind);
        for (const key of ['erase', 'restore', 'partition']) {
            b[key].sensitive = modifiable && (key !== 'partition' || node.kind === 'drive');
            b[key].tooltip_text = system
                ? `${key[0].toUpperCase()}${key.slice(1)} isn't available for the disk your system is running from`
                : `${key[0].toUpperCase()}${key.slice(1)} (opens GNOME Disks)`;
        }
        b.firstAid.sensitive = true;
        b.info.sensitive = true;
    }

    // ---- actions ----------------------------------------------------------

    async mountAction() {
        const node = this.current;
        if (!node)
            return;
        try {
            if (node.kind === 'drive' && node.external) {
                await this.ejectDrive(node);
            } else if (node.kind === 'container' && node.locked) {
                await this.unlock(node);
            } else if (node.kind === 'container') {
                await this.unmountTree(node.children[0]);
                await udisksCall(node.b.path, 'Encrypted', 'Lock', NO_OPTIONS());
            } else if (node.kind === 'volume') {
                if (node.mountPoints.length)
                    await udisksCall(node.b.path, 'Filesystem', 'Unmount', NO_OPTIONS());
                else
                    await udisksCall(node.b.path, 'Filesystem', 'Mount', NO_OPTIONS(), '(s)');
            }
        } catch (e) {
            if (!Gio.DBusError.is_remote_error(e) || !/NotAuthorized.*Dismissed|Cancelled/.test(e.message))
                this.showError(`Couldn't ${this.buttons.mount.get_child().get_last_child().label.toLowerCase()} “${node.name}”`, cleanError(e));
        }
        this.reload();
    }

    async unmountTree(node) {
        if (!node)
            return;
        for (const c of node.children)
            await this.unmountTree(c);
        if (node.kind === 'volume' && node.mountPoints.length)
            await udisksCall(node.b.path, 'Filesystem', 'Unmount', NO_OPTIONS());
        if (node.kind === 'container' && !node.locked)
            await udisksCall(node.b.path, 'Encrypted', 'Lock', NO_OPTIONS());
    }

    async ejectDrive(node) {
        for (const c of node.children)
            await this.unmountTree(c);
        if (node.drive.CanPowerOff)
            await udisksCall(node.id, 'Drive', 'PowerOff', NO_OPTIONS());
        else
            await udisksCall(node.id, 'Drive', 'Eject', NO_OPTIONS());
    }

    unlock(node) {
        return new Promise(resolve => {
            const entry = new Adw.PasswordEntryRow({title: 'Password'});
            const group = new Adw.PreferencesGroup();
            group.add(entry);
            const dialog = new Adw.AlertDialog({
                heading: `Unlock “${node.title}”`,
                body: 'Enter the password to unlock this encrypted container.',
                extra_child: group,
                default_response: 'unlock',
                close_response: 'cancel',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('unlock', 'Unlock');
            dialog.set_response_appearance('unlock', Adw.ResponseAppearance.SUGGESTED);
            entry.connect('entry-activated', () => dialog.response('unlock'));
            dialog.connect('response', async (dlg, response) => {
                if (response === 'unlock') {
                    try {
                        await udisksCall(node.b.path, 'Encrypted', 'Unlock',
                            new GLib.Variant('(sa{sv})', [entry.text, {}]), '(o)');
                    } catch (e) {
                        this.showError(`Couldn't unlock “${node.title}”`, cleanError(e));
                    }
                }
                resolve();
            });
            dialog.present(this.window);
        });
    }

    openInDisks() {
        const node = this.current;
        const device = node?.device || node?.children[0]?.device;
        try {
            const argv = ['gnome-disks'];
            if (device)
                argv.push('--block-device', device);
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            this.showError('Couldn\'t open GNOME Disks', e.message);
        }
    }

    async firstAid() {
        const node = this.current;
        if (!node)
            return;
        const checks = [];
        const add = (ok, text) => checks.push({ok, text});
        let heading = `First Aid on “${node.name}”`;

        const drive = node.kind === 'drive' ? node : this.driveOf(node);
        if (node.kind === 'drive') {
            if (node.nvme) {
                const n = node.nvme;
                let attrs = DEMO ? (await import('./demo.js')).DEMO_SMART : {};
                try {
                    if (DEMO)
                        throw new Error('demo');
                    const r = await udisksCall(node.id, 'NVMe.Controller', 'SmartGetAttributes', NO_OPTIONS(), '(a{sv})');
                    attrs = r.recursiveUnpack()[0];
                } catch (e) {
                    // not permitted or unsupported: fall back to the cached properties
                }
                const warnings = n.SmartCriticalWarning ?? [];
                add(warnings.length === 0, warnings.length ? `Critical warnings: ${warnings.join(', ')}` : 'No critical warnings reported by the drive');
                if (n.SmartTemperature)
                    add(n.SmartTemperature - 273.15 < 70, `Temperature ${(n.SmartTemperature - 273.15).toFixed(0)} °C`);
                if (n.SmartPowerOnHours)
                    add(true, `Powered on for ${n.SmartPowerOnHours.toLocaleString()} hours`);
                if (attrs.percent_used !== undefined)
                    add(attrs.percent_used < 90, `Wear level ${attrs.percent_used}% of rated endurance used`);
                if (attrs.avail_spare !== undefined)
                    add(attrs.avail_spare > (attrs.spare_thresh ?? 10), `Available spare ${attrs.avail_spare}%`);
                if (attrs.media_errors !== undefined)
                    add(attrs.media_errors === 0, `${attrs.media_errors} media errors`);
                if (attrs.unsafe_shutdowns !== undefined)
                    add(true, `${attrs.unsafe_shutdowns} unsafe shutdowns`);
                if (n.SmartUpdated)
                    add(true, `Health data from ${GLib.DateTime.new_from_unix_local(n.SmartUpdated).format('%x %X')}`);
            } else if (node.ata?.SmartSupported) {
                const a = node.ata;
                add(!a.SmartFailing, a.SmartFailing ? 'The drive reports that it is FAILING' : 'The drive reports no failure');
                add(!a.SmartNumAttributesFailing, `${a.SmartNumAttributesFailing ?? 0} attributes failing`);
                add(!a.SmartNumBadSectors, `${a.SmartNumBadSectors ?? 0} bad sectors`);
                if (a.SmartTemperature)
                    add(a.SmartTemperature - 273.15 < 60, `Temperature ${(a.SmartTemperature - 273.15).toFixed(0)} °C`);
                if (a.SmartPowerOnSeconds)
                    add(true, `Powered on for ${Math.round(a.SmartPowerOnSeconds / 3600).toLocaleString()} hours`);
            } else {
                add(null, 'This drive doesn\'t report S.M.A.R.T. health data');
            }
            add(true, `Partition map: ${node.tableType === 'gpt' ? 'GUID Partition Map' : node.tableType ?? 'none'} (${node.children.length} partitions)`);
        } else if (['volume', 'subvolume', 'group'].includes(node.kind)) {
            const mounted = node.mountPoints?.length || node.mounts?.length;
            if (node.usage) {
                const pct = node.usage.used / node.usage.size * 100;
                add(pct < 95, `${pct.toFixed(0)}% full — ${formatSize(node.usage.free)} available`);
            }
            if (mounted && node.system) {
                add(null, `“${node.name}” is in use by the running system, so it can't be checked while mounted.`);
                if (node.fsType === 'btrfs')
                    add(null, 'Btrfs verifies checksums on every read and can be scrubbed with “btrfs scrub”.');
                else
                    add(null, 'It is checked automatically when the computer starts.');
            } else if (mounted) {
                add(null, 'Unmount the volume to run a filesystem check.');
            } else if (node.canMount) {
                try {
                    const r = await udisksCall(node.b.path, 'Filesystem', 'Check', NO_OPTIONS(), '(b)');
                    const ok = r.deepUnpack()[0];
                    add(ok, ok ? 'The filesystem appears to be OK' : 'The filesystem has errors — use Repair in GNOME Disks');
                } catch (e) {
                    add(false, `Filesystem check failed: ${cleanError(e)}`);
                }
            }
            if (drive)
                add(smartStatus(drive) !== 'Failing', `Disk health (S.M.A.R.T.): ${smartStatus(drive)}`);
        } else if (node.kind === 'container') {
            add(true, `${node.encryption} header is readable`);
            add(true, node.locked ? 'Container is locked' : 'Container is unlocked');
            if (drive)
                add(smartStatus(drive) !== 'Failing', `Disk health (S.M.A.R.T.): ${smartStatus(drive)}`);
        } else {
            add(null, 'Nothing to check for this item.');
        }

        const failed = checks.some(c => c.ok === false);
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, css_classes: ['du-checks']});
        for (const c of checks) {
            const row = new Gtk.Box({spacing: 8});
            const icon = c.ok === null ? 'dialog-information-symbolic' : c.ok ? 'object-select-symbolic' : 'dialog-warning-symbolic';
            row.append(new Gtk.Image({icon_name: icon, css_classes: [c.ok === false ? 'warning' : c.ok ? 'success' : 'dim-label'], valign: Gtk.Align.START}));
            row.append(label(c.text, [], {wrap: true, hexpand: true}));
            box.append(row);
        }
        heading = failed ? `First Aid found problems on “${node.name}”` : 'First Aid process has finished';
        const dialog = new Adw.AlertDialog({
            heading,
            body: failed ? 'Back up your data as soon as possible.' : `No problems were found on “${node.name}”.`,
            extra_child: box,
        });
        dialog.add_response('done', 'Done');
        dialog.present(this.window);
    }

    driveOf(node) {
        let n = node;
        while (n?.parent)
            n = n.parent;
        return n?.kind === 'drive' ? n : null;
    }

    showInfo() {
        const node = this.current;
        if (!node)
            return;
        const page = new Adw.PreferencesPage();
        const d = describe(node);
        const summary = new Adw.PreferencesGroup({title: d.title, description: d.subtitle});
        for (const [key, value] of d.info)
            summary.add(new Adw.ActionRow({title: key, subtitle: value || '—', subtitle_selectable: true, css_classes: ['property']}));
        page.add(summary);

        const addIfaces = (ifaces, prefix) => {
            for (const [iface, props] of Object.entries(ifaces ?? {}).sort()) {
                const group = new Adw.PreferencesGroup({title: `${prefix}${iface.replace(`${UD}.`, '')}`});
                let n = 0;
                for (const [key, value] of Object.entries(props).sort()) {
                    if (/Configuration$/.test(key))
                        continue;
                    const show = v => v instanceof Uint8Array ? str(v)
                        : Array.isArray(v) ? `[${v.map(show).join(', ')}]`
                        : v && typeof v === 'object' ? JSON.stringify(v) : String(v);
                    let text = Array.isArray(value) ? value.map(show).join(', ') : show(value);
                    if (/Size$/.test(key) && typeof value === 'number' && value > 0)
                        text = `${formatSize(value)} (${value.toLocaleString()} bytes)`;
                    group.add(new Adw.ActionRow({title: key, subtitle: text || '—', subtitle_selectable: true, css_classes: ['property']}));
                    n++;
                }
                if (n)
                    page.add(group);
            }
        };
        if (node.driveIfaces)
            addIfaces(node.driveIfaces, 'Drive · ');
        if (node.b)
            addIfaces(node.b.ifaces, 'Device · ');

        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: `${node.name} Info`, child: view, content_width: 560, content_height: 640});
        dialog.present(this.window);
    }

    showError(heading, body) {
        const dialog = new Adw.AlertDialog({heading, body});
        dialog.add_response('ok', 'OK');
        dialog.present(this.window);
    }
}

function cleanError(e) {
    return (Gio.DBusError.strip_remote_error(e), e.message)
        .replace(/^GDBus\.Error:[\w.]+:\s*/, '')
        .replace(/^Error (\w+ing) [^:]+: /, '');
}

// ---- app --------------------------------------------------------------------

const app = new Adw.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    css.load_from_path(`${DIR}/style.css`);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    Gtk.Window.set_default_icon_name(APP_ID);
    const quit = new Gio.SimpleAction({name: 'quit'});
    quit.connect('activate', () => app.quit());
    app.add_action(quit);
    app.set_accels_for_action('app.quit', ['<Control>q']);
    app.set_accels_for_action('window.close', ['<Control>w']);
});
app.connect('activate', () => {
    let win = app.get_active_window();
    if (!win) {
        const w = new DiskUtilityWindow(app);
        win = w.window;
        const shot = GLib.getenv('DU_SCREENSHOT');
        if (shot)
            screenshotAndQuit(w, shot);
    }
    win.present();
});

// Testing aid: DU_SCREENSHOT=out.png [DU_SELECT=substring] renders the window to a PNG and quits.
function screenshotAndQuit(w, path) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
        const want = GLib.getenv('DU_SELECT');
        if (want && w.model) {
            const node = [...w.model.byId.values()].find(n => n.id.includes(want) || n.name.includes(want));
            if (node) {
                w.selectedId = node.id;
                w.selectRow(node.id);
                w.showDetail(node);
            }
        }
        const action = GLib.getenv('DU_ACTION');
        if (action === 'info')
            w.showInfo();
        else if (action === 'firstaid')
            w.firstAid();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const win = w.window;
            const paintable = new Gtk.WidgetPaintable({widget: win});
            const snapshot = new Gtk.Snapshot();
            paintable.snapshot(snapshot, win.get_width(), win.get_height());
            const node = snapshot.to_node();
            if (node) {
                const texture = win.get_renderer().render_texture(node, null);
                texture.save_to_png(path);
            }
            w.app.quit();
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
}

app.run([System.programInvocationName, ...ARGV]);
