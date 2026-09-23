// SPDX-License-Identifier: BUSL-1.1
// Collect unmodified notices for the production dependency closure, not dev tools.
import {readFile, readdir, realpath, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seen = new Set(), documents = [];
async function locate(name, base) {
  while (true) {
    const path = join(base, 'node_modules', name, 'package.json');
    try { return dirname(await realpath(path)); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    const parent = dirname(base);
    if (parent === base) throw new Error(`Missing production dependency ${name}; install the frozen lockfile first.`);
    base = parent;
  }
}
async function visit(directory) {
  directory = await realpath(directory);
  if (seen.has(directory)) return;
  seen.add(directory);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (!pkg.name.startsWith('@magicstick/')) {
    const names = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)).sort();
    if (!pkg.license || !names.length) throw new Error(`No complete notice evidence for ${pkg.name}@${pkg.version}`);
    const texts = [];
    for (const name of names) texts.push(`${name}\n${await readFile(join(directory, name), 'utf8')}`);
    documents.push({name: pkg.name, version: pkg.version, license: pkg.license, texts});
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) await visit(await locate(name, directory));
}
for (const workspace of ['web', 'cli']) await visit(join(root, 'dashboard/apps', workspace));
documents.sort((a, b) => a.name.localeCompare(b.name));
const text = 'Magic Stick dashboard production JavaScript dependencies\n'
  + 'Original upstream license and copyright notices. These do not license Magic Stick itself.\n\n'
  + documents.map(item => `${item.name}@${item.version} (${item.license})\n${'='.repeat(72)}\n${item.texts.join('\n\n')}`).join('\n\n');
const directory = join(root, 'licenses/third-party');
await mkdir(directory, {recursive: true});
await writeFile(join(directory, 'npm.txt'), text + '\n');
console.log(`Collected ${documents.length} production JavaScript package notices.`);
