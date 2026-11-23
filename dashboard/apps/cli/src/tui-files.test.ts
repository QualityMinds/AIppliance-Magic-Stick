import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {TuiContext} from './tui-context';
import type {DialogItem, DialogSpec} from './tui-dialogs';
import {createFileAccess, openFile, saveAs, UsbTransfer, validFileName, type UsbStatus} from './tui-files';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))); });

const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), 'magicstick-transfer-'));
  roots.push(root);
  await mkdir(join(root, 'requests'));
  await mkdir(join(root, 'status'));
  await mkdir(join(root, 'usb'));
  return root;
};

/** Plays the host helper: answers each request with the given sticks, as console-usb.py does. */
const fakeHost = (root: string, sticks: UsbStatus['sticks'], seen: Array<Record<string, unknown>> = []) => {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const request = JSON.parse(await readFile(join(root, 'requests', 'request'), 'utf8')) as Record<string, unknown>;
        await rm(join(root, 'requests', 'request'));
        seen.push(request);
        if (request.action === 'scan') for (const stick of sticks) await mkdir(join(root, 'usb', stick.name), {recursive: true});
        const remaining = request.action === 'eject' ? sticks.filter((stick) => stick.name !== request.name) : sticks;
        await writeFile(join(root, 'status', 'status.json'), JSON.stringify({requestId: request.id, sticks: remaining, message: 'ok'}));
      } catch { /* no request yet */ }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  void loop();
  return {seen, stop: () => { stopped = true; }};
};

/** A context that runs tasks immediately and records dialogs and messages. */
const harness = () => {
  const log = {dialogs: [] as DialogSpec[], messages: [] as Array<{title: string; lines: string | string[]}>, closed: 0, errors: [] as string[]};
  const pending: Array<Promise<void>> = [];
  const ctx = {
    dialog: (spec: DialogSpec) => { log.dialogs.push(spec); },
    message: (title: string, lines: string | string[]) => { log.messages.push({title, lines}); },
    close: () => { log.closed += 1; },
    task: (_title: string, operation: () => Promise<unknown>, then?: (value: unknown) => void) => {
      const run = operation().then((value) => then?.(value), (error: unknown) => { log.errors.push(error instanceof Error ? error.message : String(error)); });
      pending.push(run);
      return run;
    },
  } as unknown as TuiContext;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const item = <K extends DialogItem['kind']>(spec: DialogSpec, id: string) => spec.items().find((entry) => 'id' in entry && entry.id === id) as Extract<DialogItem, {kind: K}>;
  return {ctx, log, settle, item};
};

describe('saving and opening files', () => {
  it('saves to a new local file in a terminal and never overwrites one', async () => {
    const root = await temp();
    const {ctx, log, settle, item} = harness();
    saveAs(ctx, {}, {title: 'Save kubeconfig', defaultName: join(root, 'ada.yaml'), content: () => 'apiVersion: v1\n', done: 'No token inside.'});
    const dialog = log.dialogs[0]!;
    expect(item<'text'>(dialog, 'path').value).toBe(join(root, 'ada.yaml'));
    await dialog.submit!.run();
    await settle();
    expect(await readFile(join(root, 'ada.yaml'), 'utf8')).toBe('apiVersion: v1\n');
    expect((await stat(join(root, 'ada.yaml'))).mode & 0o777).toBe(0o600);
    expect(log.dialogs[1]!.title).toBe('Saved');
    expect(log.dialogs[1]!.description).toContain('No token inside.');
    // A second save under the same name fails instead of replacing the file.
    saveAs(ctx, {}, {title: 'Save kubeconfig', defaultName: join(root, 'ada.yaml'), content: () => 'replaced'});
    await log.dialogs[2]!.submit!.run();
    await settle();
    expect(log.errors.at(-1)).toContain('already exists');
    expect(await readFile(join(root, 'ada.yaml'), 'utf8')).toBe('apiVersion: v1\n');
  });

  it('uses USB sticks only where the console hands over a writable transfer folder', async () => {
    expect(await createFileAccess(undefined)).toEqual({});
    expect(await createFileAccess('/nonexistent-transfer')).toEqual({});
    const root = await temp();
    expect((await createFileAccess(root)).usb).toBeInstanceOf(UsbTransfer);
  });

  it('asks the host for sticks, saves a flushed new file and removes the stick safely', async () => {
    const root = await temp();
    const host = fakeHost(root, [{name: 'BACKUP', label: 'BACKUP', filesystem: 'vfat', sizeBytes: 8_000_000_000}]);
    try {
      const usb = new UsbTransfer(root, {timeoutMs: 2000, pollMs: 5});
      const {ctx, log, settle, item} = harness();
      let produced = 0;
      saveAs(ctx, {usb}, {title: 'Save license request', defaultName: 'request.json', content: () => { produced += 1; return '{"unsigned":true}'; }});
      await settle();
      expect(host.seen[0]).toMatchObject({version: 1, action: 'scan'});
      const dialog = log.dialogs[0]!;
      expect(item<'choice'>(dialog, 'stick').choices[0]!.label).toBe('BACKUP · 8.00 GB · VFAT');
      expect(produced).toBe(0);
      await dialog.submit!.run();
      await settle();
      expect(await readFile(join(root, 'usb', 'BACKUP', 'request.json'), 'utf8')).toBe('{"unsigned":true}');
      const saved = log.dialogs[1]!;
      expect(saved.description).toContain('the USB stick BACKUP');
      expect(saved.submit!.label).toBe('safely remove');
      // The same name is refused rather than replaced; path tricks are refused before writing.
      await dialog.submit!.run();
      await settle();
      expect(log.errors.at(-1)).toContain('already exists on the USB stick');
      item<'text'>(dialog, 'name').onChange('../escape.json');
      expect(dialog.submit!.disabled!()).toContain('plain file name');
      await saved.submit!.run();
      await settle();
      expect(host.seen.at(-1)).toMatchObject({action: 'eject', name: 'BACKUP'});
      expect(log.messages.at(-1)?.title).toBe('USB stick removed');
    } finally { host.stop(); }
  });

  it('opens a license file from a stick, listing only matching small files', async () => {
    const root = await temp();
    const host = fakeHost(root, [{name: 'KEYS', label: 'KEYS', filesystem: 'exfat'}]);
    try {
      await mkdir(join(root, 'usb', 'KEYS', 'licenses', 'nested', 'deeper'), {recursive: true});
      await writeFile(join(root, 'usb', 'KEYS', 'signed.license'), 'signed-document');
      await writeFile(join(root, 'usb', 'KEYS', 'licenses', 'second.json'), '{}');
      await writeFile(join(root, 'usb', 'KEYS', 'licenses', 'nested', 'deeper', 'too-deep.json'), '{}');
      await writeFile(join(root, 'usb', 'KEYS', 'notes.txt'), 'ignored');
      await writeFile(join(root, 'usb', 'KEYS', '.hidden.json'), '{}');
      await writeFile(join(root, 'usb', 'KEYS', 'large.json'), Buffer.alloc(70_000));
      const usb = new UsbTransfer(root, {timeoutMs: 2000, pollMs: 5});
      const {ctx, log, settle, item} = harness();
      const opened: Array<{content: string; name: string}> = [];
      openFile(ctx, {usb}, {title: 'Import license', extensions: ['.json', '.license'], maxBytes: 64 * 1024,
        read: (path) => readFile(path, 'utf8'), open: (content, name) => { opened.push({content, name}); }});
      await settle();
      const dialog = log.dialogs[0]!;
      const file = item<'choice'>(dialog, 'file');
      expect(file.choices.map((choice) => choice.value)).toEqual(['large.json', 'licenses/second.json', 'signed.license']);
      expect(file.choices[0]!.disabled).toContain('larger than');
      expect(file.value).toBe('licenses/second.json');
      file.onChange('signed.license');
      await dialog.submit!.run();
      await settle();
      expect(opened).toEqual([{content: 'signed-document', name: 'signed.license'}]);
    } finally { host.stop(); }
  });

  it('reports a host that does not answer, and rejects unsafe stick and file names', async () => {
    const root = await temp();
    const usb = new UsbTransfer(root, {timeoutMs: 50, pollMs: 5});
    await expect(usb.request('scan')).rejects.toThrow('did not answer');
    await expect(usb.request('eject', '../etc')).rejects.toThrow('not valid');
    expect(() => usb.stickPath('../root')).toThrow('not valid');
    expect(validFileName('report.html')).toBeUndefined();
    expect(validFileName('a/b.html')).toContain('plain file name');
    expect(validFileName('..')).toContain('plain file name');
    expect(validFileName('')).toBe('Enter a file name.');
  });
});
