import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {X509Certificate} from 'node:crypto';
import {requireSafe} from './errors.ts';
import {readPrivate, writePrivate} from './private-files.ts';

/** Linux worker trust is isolated; never ignore browser HTTPS errors or change
 * the host trust store. Node must start again to read the reviewed extra CA. */
export async function browserTrust(caFile?: string) {
  requireSafe(process.platform === 'linux', 'CONFIG');
  const home = await mkdtemp(join(tmpdir(), 'magicstick-browser-'));
  const environment: NodeJS.ProcessEnv = {...process.env, HOME: home};
  delete environment.NODE_EXTRA_CA_CERTS;
  delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    if (caFile) {
      const bundle = await readPrivate(caFile);
      requireSafe(bundle.length < 256 * 1024 && !bundle.includes('PRIVATE KEY'), 'TLS');
      const certs = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
      requireSafe(certs.length > 0 && certs.length < 20, 'TLS');
      const database = join(home, '.pki/nssdb');
      await mkdir(database, {recursive: true, mode: 0o700});
      execFileSync('certutil', ['-N', '--empty-password', '-d', 'sql:' + database], {stdio: 'pipe'});
      for (const [index, cert] of certs.entries()) {
        const parsed = new X509Certificate(cert);
        requireSafe(parsed.ca && Date.parse(parsed.validFrom) <= Date.now() && Date.parse(parsed.validTo) > Date.now(), 'TLS');
        const filename = join(home, 'ca-' + index + '.pem');
        await writePrivate(filename, cert);
        execFileSync('certutil', ['-A', '-d', 'sql:' + database, '-n', 'lab-' + index, '-t', 'C,,', '-i', filename], {stdio: 'pipe'});
      }
      environment.NODE_EXTRA_CA_CERTS = caFile;
    }
    return {home, environment};
  } catch (error) {
    const {rm} = await import('node:fs/promises');
    await rm(home, {recursive: true, force: true});
    throw error;
  }
}
