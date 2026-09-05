import {promises as fs} from 'node:fs';
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
  `License: ${status.state}`, status.message,
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
    `Valid from: ${new Date(preview.candidate.claims.notBefore * 1000).toISOString()}`,
    `Expires: ${new Date(preview.candidate.claims.expiresAt * 1000).toISOString()}`,
    `Installation binding: ${preview.candidate.claims.installationId ?? 'unbound'}`,
    `Entitlements: ${preview.candidate.claims.features.join(', ') || 'none'}`,
  ] : []),
];
