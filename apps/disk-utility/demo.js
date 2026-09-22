// Made-up disks for DU_DEMO=1: a Fedora laptop with an encrypted Btrfs install
// plus an external USB drive. Shaped like UDisks2's GetManagedObjects() reply.

const bytes = s => new TextEncoder().encode(`${s}\0`);
const U = 'org.freedesktop.UDisks2.';
const GB = 1e9;

const DRIVE = '/org/freedesktop/UDisks2/drives/Samsung_SSD_990_PRO_2TB_S7DNNJ0W000000X';
const USB = '/org/freedesktop/UDisks2/drives/SanDisk_Extreme_55AE_32343133';
const BD = '/org/freedesktop/UDisks2/block_devices/';

const block = (dev, size, extra = {}) => ({
    Device: bytes(`/dev/${dev}`),
    PreferredDevice: bytes(extra.preferred ?? `/dev/${dev}`),
    Size: size,
    Drive: extra.drive ?? '/',
    CryptoBackingDevice: extra.backing ?? '/',
    IdUsage: extra.usage ?? '',
    IdType: extra.type ?? '',
    IdVersion: extra.version ?? '',
    IdLabel: extra.label ?? '',
    IdUUID: extra.uuid ?? '',
    HintSystem: extra.system ?? true,
    HintIgnore: false,
});

const partition = (table, number, offset, size, type, name = '') => ({
    Number: number, Offset: offset, Size: size, Type: type, Name: name,
    UUID: `0b7d3e2a-51c4-4e8f-9a1d-00000000000${number}`, Table: table,
});

const fs = (...mountPoints) => ({MountPoints: mountPoints.map(bytes), Size: 0});

const DISK = 2000398934016;
const EFI = 629145600, BOOT = 2147483648;
const LUKS = DISK - EFI - BOOT - 3145728;
const USB_SIZE = 1000170586112;

export const DEMO_SMART = {percent_used: 2, avail_spare: 100, spare_thresh: 10, media_errors: 0, unsafe_shutdowns: 14};

export function demoSource() {
    const objects = {
        [DRIVE]: {
            [`${U}Drive`]: {
                Vendor: '', Model: 'Samsung SSD 990 PRO 2TB', Revision: '4B2QJXD7', Serial: 'S7DNNJ0W000000X',
                Size: DISK, Removable: false, MediaRemovable: false, ConnectionBus: '', RotationRate: 0,
                CanPowerOff: false, SortKey: '00coldplug/00fixed/nvme0',
            },
            [`${U}NVMe.Controller`]: {
                State: 'live', NVMeRevision: '2.0', SmartUpdated: Math.floor(Date.now() / 1000) - 300,
                SmartCriticalWarning: [], SmartPowerOnHours: 812, SmartTemperature: 311, SmartSelftestStatus: 'success',
            },
        },
        [`${BD}nvme0n1`]: {
            [`${U}Block`]: block('nvme0n1', DISK, {drive: DRIVE}),
            [`${U}PartitionTable`]: {Type: 'gpt', Partitions: []},
        },
        [`${BD}nvme0n1p1`]: {
            [`${U}Block`]: block('nvme0n1p1', EFI, {drive: DRIVE, usage: 'filesystem', type: 'vfat', version: 'FAT32', uuid: '6C1E-94A2'}),
            [`${U}Partition`]: partition(`${BD}nvme0n1`, 1, 1048576, EFI, 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', 'EFI System Partition'),
            [`${U}Filesystem`]: fs('/boot/efi'),
        },
        [`${BD}nvme0n1p2`]: {
            [`${U}Block`]: block('nvme0n1p2', BOOT, {drive: DRIVE, usage: 'filesystem', type: 'ext4', version: '1.0', uuid: '3f0a9c1e-7d2b-4c55-8e61-2b9d4a7c0f13'}),
            [`${U}Partition`]: partition(`${BD}nvme0n1`, 2, 1048576 + EFI, BOOT, '0fc63daf-8483-4772-8e79-3d69d8477de4'),
            [`${U}Filesystem`]: fs('/boot'),
        },
        [`${BD}nvme0n1p3`]: {
            [`${U}Block`]: block('nvme0n1p3', LUKS, {drive: DRIVE, usage: 'crypto', type: 'crypto_LUKS', version: '2', uuid: '8e2d6b0c-4f7a-4b1e-9c3d-5a6e7f809a1b'}),
            [`${U}Partition`]: partition(`${BD}nvme0n1`, 3, 1048576 + EFI + BOOT, LUKS, '0fc63daf-8483-4772-8e79-3d69d8477de4'),
            [`${U}Encrypted`]: {MetadataSize: 16777216, CleartextDevice: `${BD}dm_2d0`},
        },
        [`${BD}dm_2d0`]: {
            [`${U}Block`]: block('dm-0', LUKS - 16777216, {
                preferred: '/dev/mapper/luks-8e2d6b0c', backing: `${BD}nvme0n1p3`,
                usage: 'filesystem', type: 'btrfs', label: 'fedora', uuid: 'c4a1f0d2-9e3b-4d7a-b8c6-1f2e3d4c5b6a',
            }),
            [`${U}Filesystem`]: fs('/', '/home'),
        },
        [USB]: {
            [`${U}Drive`]: {
                Vendor: 'SanDisk', Model: 'Extreme 55AE', Revision: '4000', Serial: '32343133000000',
                Size: USB_SIZE, Removable: true, MediaRemovable: false, ConnectionBus: 'usb', RotationRate: 0,
                CanPowerOff: true, SortKey: '01hotplug/sda',
            },
        },
        [`${BD}sda`]: {
            [`${U}Block`]: block('sda', USB_SIZE, {drive: USB, system: false}),
            [`${U}PartitionTable`]: {Type: 'gpt', Partitions: []},
        },
        [`${BD}sda1`]: {
            [`${U}Block`]: block('sda1', USB_SIZE - 2097152, {drive: USB, system: false, usage: 'filesystem', type: 'exfat', version: '1.0', label: 'Photos', uuid: '5E1A-2B3C'}),
            [`${U}Partition`]: partition(`${BD}sda`, 1, 1048576, USB_SIZE - 2097152, 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7', 'Photos'),
            [`${U}Filesystem`]: fs('/run/media/demo/Photos'),
        },
    };

    const btrfs = (root, mountPoint, id) => ({
        root, mountPoint, options: 'rw,relatime', fsType: 'btrfs', source: '/dev/mapper/luks-8e2d6b0c',
        superOptions: `rw,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2,subvolid=${id},subvol=${root}`,
    });
    const mountInfo = [btrfs('/root', '/', 257), btrfs('/home', '/home', 256)];

    const btrfsSize = LUKS - 16777216;
    const usage = {
        '/': {size: btrfsSize, used: 412.6 * GB, free: btrfsSize - 412.6 * GB, readonly: false},
        '/home': {size: btrfsSize, used: 412.6 * GB, free: btrfsSize - 412.6 * GB, readonly: false},
        '/boot/efi': {size: EFI, used: 25.1e6, free: EFI - 25.1e6, readonly: false},
        '/boot': {size: BOOT, used: 412e6, free: BOOT - 412e6, readonly: false},
        '/run/media/demo/Photos': {size: USB_SIZE, used: 637.4 * GB, free: USB_SIZE - 637.4 * GB, readonly: false},
    };

    return {
        objects,
        mountInfo,
        usage: async mp => usage[mp] ?? null,
        os: 'Fedora Linux 44 (Workstation Edition)',
    };
}
