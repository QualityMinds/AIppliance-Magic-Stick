import {test, expect} from '@playwright/test';
import {createServer} from 'node:https';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {regressionContextOptions} from '../core/https-policy.ts';
import {probeModuleServices} from '../core/service-probes.ts';
import {verifiedEndpoint} from '../core/preflight.ts';
import {InferenceProbe} from '../core/inference.ts';
import {realtimeSession} from '../core/realtime-probe.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

test('HAR-01 HAR-10 functional browser, service, inference and Realtime checks exclude certificates; certificate checks remain strict',
  evidenceAnnotations({id: 'HAR-10', layer: 'B'}), async ({browser, playwright}) => {
    const directory = await mkdtemp(join(tmpdir(), 'regression-https-'));
    let server: ReturnType<typeof createServer> | undefined;
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const apis: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
    const priorGlobalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    let serviceStatus = 200, inferenceStatus = 200, sessionType = 'session.created';
    try {
      const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-subj', '/CN=not-this-host.invalid', '-days', '1', '-addext', 'subjectAltName=DNS:not-this-host.invalid'], {stdio: 'pipe'});
      server = createServer({key: await readFile(key), cert: await readFile(cert)}, (request, response) => {
        if (request.url === '/v1/chat/completions' || request.url === '/v1/models') {
          response.writeHead(inferenceStatus, {'Content-Type': 'application/json'});
          response.end(JSON.stringify(request.url === '/v1/models' ? {data: [{id: 'fixture'}]} :
            {model: 'fixture', choices: [{message: {content: 'OK'}}]}));
        } else {
          response.writeHead(serviceStatus, {'Content-Type': 'text/html',
            ...(serviceStatus === 302 ? {Location: 'https://unreachable.example.invalid/'} : {})});
          response.end('<h1>Synthetic functional service</h1>');
        }
      });
      server.on('upgrade', (request, socket) => {
        const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const payload = Buffer.from(JSON.stringify({type: sessionType, session: {id: 'synthetic'}}));
        socket.end(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const origin = 'https://127.0.0.1:' + (server.address() as {port: number}).port;

      await expect(verifiedEndpoint(origin, 2000)).rejects.toMatchObject({code: 'TLS'});
      await expect(verifiedEndpoint(origin, 2000, await readFile(cert, 'utf8'))).rejects.toMatchObject({code: 'TLS'});
      const strict = await browser.newContext(regressionContextOptions('certificate')); contexts.push(strict);
      await expect((await strict.newPage()).goto(origin)).rejects.toThrow();
      const api = await playwright.request.newContext(); apis.push(api);
      await expect(api.get(origin)).rejects.toThrow();

      const functional = await browser.newContext(regressionContextOptions()); contexts.push(functional);
      const page = await functional.newPage();
      await page.goto(origin);
      await expect(page.getByRole('heading', {name: 'Synthetic functional service'})).toBeVisible();
      expect((await functional.request.get(origin)).status()).toBe(200);
      const links = [{url: origin, label: 'Synthetic service', scope: 'direct' as const}];
      await probeModuleServices(api, links, 2000); // Per-request purpose, even on a strict API context.
      serviceStatus = 302;
      await probeModuleServices(api, links, 2000); // Do not follow the unreachable redirect.
      serviceStatus = 503;
      await expect(probeModuleServices(api, links, 2000)).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      const inference = new InferenceProbe(api, origin, 'sk-synthetic-fixture', 2000);
      expect(await inference.advertised('fixture')).toBe(true);
      await inference.chat('fixture');
      inferenceStatus = 500;
      await expect(inference.chat('fixture')).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      await realtimeSession(origin, 'fixture', 'sk-synthetic-fixture', false, 2000);
      sessionType = 'error';
      await expect(realtimeSession(origin, 'fixture', 'sk-synthetic-fixture', false, 2000)).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      // No policy leaks into the explicit TLS check or process environment.
      await expect(verifiedEndpoint(origin, 2000)).rejects.toMatchObject({code: 'TLS'});
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(priorGlobalTls);
    } finally {
      for (const api of apis) await api.dispose();
      for (const context of contexts) await context.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await rm(directory, {recursive: true, force: true});
    }
  });
