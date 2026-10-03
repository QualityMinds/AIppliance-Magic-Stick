// SPDX-License-Identifier: BUSL-1.1
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod, copyFile, mkdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export async function verifyAsset(path, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid runtime checksum.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Runtime checksum mismatch; refusing to execute downloaded code.');
}

export async function install(runtimeDir, architecture = process.arch) {
  const lock = JSON.parse(await readFile(new URL('./runtime-lock.json', import.meta.url), 'utf8'));
  const pi = lock.pi.assets[architecture];
  const ttyd = lock.ttyd.assets[architecture];
  if (!pi || !ttyd) throw new Error('Pi Coding supports Linux amd64 and arm64 only.');
  await mkdir(runtimeDir, {recursive: true});
  const archive = join(runtimeDir, 'pi.tar.gz');
  const terminal = join(runtimeDir, 'ttyd');
  for (const [asset, path] of [[pi, archive], [ttyd, terminal]]) {
    const result = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--connect-timeout', '15', '--max-time', '180', '--retry-max-time', '300',
      '--proto', '=https', '--tlsv1.2', '--output', path, asset.url], {stdio: 'inherit'});
    if (result.status !== 0) throw new Error('Unable to download the pinned Pi Coding runtime. Check GitHub connectivity.');
    await verifyAsset(path, asset.sha256);
  }
  if (spawnSync('tar', ['-xzf', archive, '-C', runtimeDir], {stdio: 'inherit'}).status !== 0) {
    throw new Error('Unable to extract the verified Pi Coding runtime.');
  }
  await chmod(terminal, 0o755);
  await mkdir(join(runtimeDir, 'licenses'), {recursive: true});
  for (const name of ['LICENSE-pi.txt', 'LICENSE-ttyd.txt']) {
    await copyFile(new URL(name, import.meta.url), join(runtimeDir, 'licenses', name));
  }
  await rm(archive);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  install(process.env.PI_RUNTIME_DIR || '/runtime').catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
