import {constants} from 'node:fs';
import {link, lstat, mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HarnessError, requireSafe} from './errors.ts';

export async function privateDirectory(path: string) {
  await mkdir(path, {recursive: true, mode: 0o700});
  const stat = await lstat(path);
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'PRIVATE_FILE');
}

export async function readPrivate(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    requireSafe(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 1024 * 1024, 'PRIVATE_FILE');
    return await handle.readFile({encoding: 'utf8'});
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('PRIVATE_FILE');
  } finally { await handle?.close(); }
}

/** Durable, mode-0600 atomic journal/report writes. Never follows a target symlink. */
export async function writePrivate(path: string, value: unknown, exclusive = false) {
  await privateDirectory(dirname(path));
  try {
    const previous = await lstat(path);
    requireSafe(!exclusive && previous.isFile() && !previous.isSymbolicLink(), 'PRIVATE_FILE');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    // Linking is atomic and cannot overwrite a journal created by another run.
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('PRIVATE_FILE');
  } finally { await rm(temporary, {force: true}); }
}
