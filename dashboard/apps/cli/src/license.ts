import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {LicensePreview, LicenseStatus} from '@magicstick/dashboard-contracts';

export const readLicenseFile = async (path: string) => {
  if (!(await fs.stat(path)).isFile()) throw new Error('Select a regular license file.');
  const handle = await fs.open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Select a regular license file.');
    // Bounded read, including a file growing after stat().
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 64 * 1024) throw new Error('License file exceeds 64 KiB.');
    return new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
};
export const saveLicenseFile = async (path: string, content: string) => {
  await fs.writeFile(path, content, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
};
export const licenseLines = (status: LicenseStatus) => [
  `License: ${status.state}`, `Edition: ${status.edition}`, status.message,
  `Installation: ${status.installationId}`,
  `Trusted keys: ${status.trustedKeyIds.join(', ') || 'none'}`,
  ...(status.claims ? [`Customer: ${status.claims.customer}`, `License ID: ${status.claims.licenseId}`, `Expires: ${new Date(status.claims.expiresAt * 1000).toISOString()}`] : []),
  ...status.features.map((f) => `${f.name}: ${f.licensed ? 'licensed' : 'not licensed'} · ${f.implemented ? 'implemented' : 'not implemented'}`),
];
export const previewLines = (preview: LicensePreview) => [
  preview.candidate.message,
  `Current license: ${preview.current.claims?.licenseId ?? 'none'}`,
  ...(preview.candidate.claims ? [
    `New license: ${preview.candidate.claims.licenseId}`, `Customer: ${preview.candidate.claims.customer}`,
    `Edition: ${preview.candidate.claims.edition}`,
    `Valid from: ${new Date(preview.candidate.claims.notBefore * 1000).toISOString()}`,
    `Expires: ${new Date(preview.candidate.claims.expiresAt * 1000).toISOString()}`,
    `Installation binding: ${preview.candidate.claims.installationId ?? 'unbound'}`,
    `Entitlements: ${preview.candidate.claims.features.join(', ') || 'none'}`,
  ] : []),
];

/** The offline license texts the browser's System → License page offers, as shipped with the installation. */
export interface LicenseDocument {
  title: string;
  /** Suggested file name for a saved copy. */
  filename: string;
  /** Path relative to the license directory of the container (`/licenses`) and to the repository root. */
  path: string;
}

export const LICENSE_DOCUMENTS: LicenseDocument[] = [
  {title: 'Licensing overview', filename: 'LICENSING.md', path: 'LICENSING.md'},
  {title: 'Business Source License 1.1', filename: 'MagicStick-BSL.txt', path: 'LICENSE'},
  {title: 'MIT Change License · after three years per version', filename: 'MIT-CHANGE.txt', path: 'licenses/MIT-CHANGE.txt'},
  {title: 'Third-party notices', filename: 'THIRD_PARTY_NOTICES.md', path: 'THIRD_PARTY_NOTICES.md'},
  {title: 'JavaScript dependency license texts', filename: 'npm-notices.txt', path: 'licenses/third-party/npm.txt'},
  {title: 'Python dependency license texts', filename: 'python-notices.txt', path: 'licenses/third-party/python.txt'},
];

/**
 * Where the texts are read at runtime: the CLI image copies them to /licenses; a source checkout
 * has them at the repository root (four levels above apps/cli/src or apps/cli/dist). They are never bundled.
 */
export const licenseDocumentRoots = () => {
  const roots = ['/licenses'];
  try { roots.push(fileURLToPath(new URL('../../../../', import.meta.url))); } catch { /* not a file URL */ }
  return roots;
};

export const readLicenseDocument = async (document: LicenseDocument, roots = licenseDocumentRoots()) => {
  for (const root of roots) {
    try { return await fs.readFile(join(root, document.path), 'utf8'); } catch { /* try the next location */ }
  }
  throw new Error(`${document.title} is not installed with this command-line tool. It is available in the browser dashboard and in the source repository.`);
};
