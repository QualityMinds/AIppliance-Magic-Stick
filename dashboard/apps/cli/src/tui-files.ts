// Saving and opening files from the terminal dashboard, the counterpart of browser
// downloads and file inputs. In an ordinary terminal the user types a local path.
// On the appliance's own monitor the TUI runs in the console Pod, whose files nobody
// can reach; there it saves to and opens from a USB stick that the host mounts on
// request (magic-host/roles/dashboard-console/files/console-usb.py).
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {homedir} from 'node:os';
import {join, relative} from 'node:path';
import {formatBytes} from '@magicstick/dashboard-core';
import type {TuiContext} from './tui-context';
import type {DialogItem} from './tui-dialogs';

/** Writes a new file with private permissions; `~/` means the home directory. Never overwrites. */
export const saveNewFile = async (path: string, content: string | Uint8Array) => {
  const target = path.trim().replace(/^~(?=\/|$)/, homedir());
  if (!target) throw new Error('Enter a file path.');
  try {
    await fs.writeFile(target, content, {mode: 0o600, flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${target} already exists. Choose a new file name; existing files are never overwritten.`);
    throw error;
  }
  return target;
};

/** Reads a small UTF-8 text file, refusing anything that is not a regular file or is larger than the limit. */
export const readBoundedText = async (path: string, maxBytes: number) => {
  const target = path.trim().replace(/^~(?=\/|$)/, homedir());
  const handle = await fs.open(target, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Select a regular file.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new Error(`The file is larger than ${formatBytes(maxBytes)}.`);
    return new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
};

export interface UsbStick {
  name: string;
  label: string;
  filesystem: string;
  sizeBytes?: number;
}

export interface UsbStatus {
  requestId?: string;
  updatedAt?: string;
  sticks: UsbStick[];
  message?: string;
  error?: boolean;
}

export interface UsbFile {
  /** Path relative to the stick. */
  path: string;
  sizeBytes: number;
}

const STICK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const validFileName = (value: string) => {
  const name = value.trim();
  if (!name) return 'Enter a file name.';
  if (name.length > 128) return 'Use at most 128 characters for the file name.';
  if (/[/\\\u0000-\u001f]/.test(name) || name === '.' || name === '..') return 'Use a plain file name without folders or control characters.';
  return undefined;
};

/**
 * The console side of the host's USB helper. Requests are a small JSON file in a
 * folder only this Pod may write; the host answers in a status file next to it.
 * The host mounts sticks below `usb/`, visible here through mount propagation.
 */
export class UsbTransfer {
  status?: UsbStatus;

  constructor(readonly root: string, private readonly timing = {timeoutMs: 20_000, pollMs: 200}) {}

  /** Asks the host to look for sticks (`scan`) or to unmount one (`eject`) and waits for its answer. */
  async request(action: 'scan' | 'eject', name?: string): Promise<UsbStatus> {
    if (name !== undefined && !STICK_NAME.test(name)) throw new Error('This USB stick name is not valid.');
    const id = randomUUID();
    await fs.writeFile(join(this.root, 'requests', 'request'), JSON.stringify({version: 1, id, action, ...(name ? {name} : {})}), {mode: 0o600});
    const deadline = Date.now() + this.timing.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.timing.pollMs);
      const status = await this.readStatus();
      if (status?.requestId !== id) continue;
      this.status = status;
      if (status.error) throw new Error(status.message || 'The USB request failed.');
      return status;
    }
    throw new Error('The appliance did not answer the USB request in time. USB sticks need the current host configuration of the appliance console.');
  }

  async readStatus(): Promise<UsbStatus | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(join(this.root, 'status', 'status.json'), 'utf8')) as Partial<UsbStatus>;
      return {...value, sticks: Array.isArray(value.sticks) ? value.sticks.filter((item) => STICK_NAME.test(String(item?.name ?? ''))) : []};
    } catch { return undefined; }
  }

  stickPath(name: string) {
    if (!STICK_NAME.test(name)) throw new Error('This USB stick name is not valid.');
    return join(this.root, 'usb', name);
  }

  /** Files on a stick with one of the extensions, two folder levels deep; hidden entries are skipped. */
  async listFiles(name: string, extensions: string[], limit = 200): Promise<UsbFile[]> {
    const base = this.stickPath(name);
    const found: UsbFile[] = [];
    const visit = async (directory: string, depth: number) => {
      const entries = await fs.readdir(directory, {withFileTypes: true}).catch(() => []);
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (found.length >= limit || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 2) await visit(path, depth + 1);
        else if (entry.isFile() && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
          const stat = await fs.lstat(path).catch(() => undefined);
          if (stat?.isFile()) found.push({path: relative(base, path), sizeBytes: stat.size});
        }
      }
    };
    await visit(base, 0);
    return found;
  }

  /** Writes a new file to the stick and flushes it, so the stick can be removed safely afterwards. */
  async write(name: string, fileName: string, content: string | Uint8Array) {
    const invalid = validFileName(fileName);
    if (invalid) throw new Error(invalid);
    const target = join(this.stickPath(name), fileName.trim());
    let handle;
    try {
      handle = await fs.open(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${fileName.trim()} already exists on the USB stick. Choose a new file name; existing files are never overwritten.`);
      throw error;
    }
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    return target;
  }
}

/** Where files go: typed local paths, or USB sticks on the appliance console. */
export interface FileAccess {
  usb?: UsbTransfer;
}

/** USB sticks are used only where the console launcher handed over a writable transfer folder. */
export const createFileAccess = async (transferDirectory?: string): Promise<FileAccess> => {
  if (!transferDirectory) return {};
  try {
    await fs.access(join(transferDirectory, 'requests'), fs.constants.W_OK);
    return {usb: new UsbTransfer(transferDirectory)};
  } catch { return {}; }
};

export interface SaveSpec {
  title: string;
  description?: string;
  defaultName: string;
  /** Produces the file content when the user saves (it may call the API). */
  content: () => Promise<string | Uint8Array> | string | Uint8Array;
  /** First line of the confirmation, e.g. "The kubeconfig contains no token or password." */
  done?: string;
  /** Return to the dialog or viewer that opened the save dialog. */
  back?: boolean;
}

export interface OpenSpec {
  title: string;
  description?: string;
  /** Lower-case extensions offered from a USB stick, e.g. ['.json', '.license']. */
  extensions: string[];
  maxBytes: number;
  /** Reads a chosen file (local path or file on the stick). */
  read: (path: string) => Promise<string>;
  /** Receives the content; `name` is the path the user chose. */
  open: (content: string, name: string) => void;
}

const stickLabel = (stick: UsbStick) => `${stick.label || stick.name}${stick.sizeBytes ? ` · ${formatBytes(stick.sizeBytes)}` : ''} · ${stick.filesystem.toUpperCase()}`;
const NO_STICK = 'No USB stick found. Plug in a stick formatted as FAT32 or exFAT, then choose Scan for USB sticks.';
const USB_NOTE = 'The appliance mounts a stick only when you ask for it, never runs programs from it, and offers only FAT32 and exFAT sticks.';

/** Unmounts a stick after flushing it, then says it can be unplugged. */
export const safelyRemove = (ctx: TuiContext, usb: UsbTransfer, name: string) => {
  const stick = usb.status?.sticks.find((item) => item.name === name);
  void ctx.task('Safely removing the USB stick', () => usb.request('eject', name),
    () => ctx.message('USB stick removed', `${stick ? stickLabel(stick) : name} was unmounted. You can unplug it now.`));
};

const stickItems = (ctx: TuiContext, usb: UsbTransfer, state: {stick: string}, onScan: () => void): DialogItem[] => {
  const sticks = usb.status?.sticks ?? [];
  return [
    ...(sticks.length
      ? [{kind: 'choice' as const, id: 'stick', label: 'USB stick', value: state.stick, choices: sticks.map((item) => ({value: item.name, label: stickLabel(item)})),
        onChange: (value: string) => { state.stick = value; }}]
      : [{kind: 'note' as const, text: NO_STICK, tone: 'warn' as const}]),
    {kind: 'buttons', items: [
      {id: 'scan', label: 'Scan for USB sticks', onPress: onScan},
      {id: 'eject', label: 'Safely remove', disabled: state.stick ? undefined : 'No USB stick is selected.', onPress: () => safelyRemove(ctx, usb, state.stick)},
    ]},
  ];
};

const keepStick = (usb: UsbTransfer, state: {stick: string}) => {
  const sticks = usb.status?.sticks ?? [];
  if (!sticks.some((item) => item.name === state.stick)) state.stick = sticks[0]?.name ?? '';
};

/** The browser's download, as a save dialog: a local path, or a USB stick on the appliance console. */
export const saveAs = (ctx: TuiContext, files: FileAccess, spec: SaveSpec) => {
  const usb = files.usb;
  const saved = (where: string, stick?: string) => {
    // Return to whatever opened the save dialog, then confirm on top of it.
    ctx.close();
    ctx.dialog({
      title: 'Saved',
      description: [spec.done, `Saved to ${where}.`].filter(Boolean).join(' '),
      items: () => stick ? [{kind: 'note', text: 'Choose Safely remove before unplugging the USB stick.'}] : [],
      ...(stick && usb ? {submit: {label: 'safely remove', run: () => safelyRemove(ctx, usb, stick)}} : {}),
      cancelLabel: 'Close',
    }, true);
  };
  if (!usb) {
    const state = {path: spec.defaultName};
    return ctx.dialog({
      title: spec.title,
      description: spec.description ?? 'Save as a new local file. Existing files are never overwritten; the file is readable only by you.',
      items: () => [{kind: 'text', id: 'path', label: 'File', value: state.path, required: true, onChange: (value) => { state.path = value; }}],
      submit: {label: 'save', run: () => ctx.task(spec.title, async () => saveNewFile(state.path, await spec.content()), (path) => saved(path))},
    }, spec.back);
  }
  const state = {stick: usb.status?.sticks[0]?.name ?? '', name: spec.defaultName};
  const scan = () => void ctx.task('Looking for USB sticks', () => usb.request('scan'), () => keepStick(usb, state));
  ctx.dialog({
    title: spec.title,
    description: spec.description ?? 'Save to a USB stick plugged into this appliance. Existing files are never overwritten.',
    items: () => [
      ...stickItems(ctx, usb, state, scan),
      {kind: 'text', id: 'name', label: 'File name', value: state.name, required: true, maxLength: 128, onChange: (value) => { state.name = value; }},
      {kind: 'note', text: USB_NOTE},
    ],
    submit: {
      label: 'save to USB stick',
      disabled: () => !state.stick ? 'Choose a USB stick first.' : validFileName(state.name),
      run: () => ctx.task(spec.title, async () => usb.write(state.stick, state.name, await spec.content()), () => {
        const stick = usb.status?.sticks.find((item) => item.name === state.stick);
        saved(`the USB stick ${stick ? stickLabel(stick) : state.stick} as ${state.name.trim()}`, state.stick);
      }),
    },
  }, spec.back);
  // The user asked to save to a stick: look for one right away.
  scan();
};

/** The browser's file input: a local path, or a file on a USB stick on the appliance console. */
export const openFile = (ctx: TuiContext, files: FileAccess, spec: OpenSpec) => {
  const usb = files.usb;
  const read = (path: string, name: string) => void ctx.task(`Reading ${name}`, () => spec.read(path), (content) => spec.open(content, name));
  if (!usb) {
    const state = {path: ''};
    return ctx.dialog({
      title: spec.title,
      description: spec.description,
      items: () => [{kind: 'text', id: 'path', label: 'File', value: state.path, required: true, onChange: (value) => { state.path = value; }}],
      submit: {label: 'open', run: () => read(state.path, state.path.trim())},
    });
  }
  const state = {stick: usb.status?.sticks[0]?.name ?? '', file: '', files: {} as Record<string, UsbFile[]>};
  const listAll = async () => {
    const status = await usb.request('scan');
    const listed: Record<string, UsbFile[]> = {};
    for (const stick of status.sticks) listed[stick.name] = await usb.listFiles(stick.name, spec.extensions);
    return listed;
  };
  const scan = () => void ctx.task('Looking for USB sticks', listAll, (listed) => {
    state.files = listed;
    keepStick(usb, state);
    const available = (state.files[state.stick] ?? []).filter((item) => item.sizeBytes <= spec.maxBytes);
    if (!available.some((item) => item.path === state.file)) state.file = available[0]?.path ?? '';
  });
  const fileItems = (): DialogItem[] => {
    if (!state.stick) return [];
    const found = state.files[state.stick] ?? [];
    // Switching sticks keeps a file of that stick selected.
    if (!found.some((item) => item.path === state.file && item.sizeBytes <= spec.maxBytes)) state.file = found.find((item) => item.sizeBytes <= spec.maxBytes)?.path ?? '';
    if (!found.length) return [{kind: 'note', text: `No ${spec.extensions.join(' or ')} file was found on this stick (top level and two folder levels).`, tone: 'warn'}];
    return [{kind: 'choice', id: 'file', label: 'File', value: state.file, onChange: (value) => { state.file = value; },
      choices: found.map((item) => ({value: item.path, label: `${item.path} · ${formatBytes(item.sizeBytes)}`,
        ...(item.sizeBytes > spec.maxBytes ? {disabled: `larger than ${formatBytes(spec.maxBytes)}`} : {})}))}];
  };
  ctx.dialog({
    title: spec.title,
    description: spec.description,
    items: () => [
      ...stickItems(ctx, usb, state, scan),
      ...fileItems(),
      {kind: 'note', text: USB_NOTE},
    ],
    submit: {
      label: 'open',
      disabled: () => !state.stick ? 'Choose a USB stick first.' : !state.file ? 'Choose a file first.' : undefined,
      run: () => read(join(usb.stickPath(state.stick), state.file), state.file),
    },
  });
  scan();
};
