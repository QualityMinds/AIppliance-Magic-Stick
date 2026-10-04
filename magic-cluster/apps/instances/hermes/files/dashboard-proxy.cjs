// SPDX-License-Identifier: BUSL-1.1
"use strict";
const http = require("node:http");

// Hermes' supported loopback dashboard keeps its own per-process SPA token.
// Only the SSO-protected Service exposes this proxy. Validate browser origins
// before translating them to the loopback authority expected by native HTTP/WS.
function createProxy({ hosts, upstreamPort = 9118 }) {
  const allowed = new Set(hosts.filter(Boolean).map((host) => host.toLowerCase()));
  function headersFor(request) {
    let host;
    try { host = new URL(`http://${request.headers.host}`).hostname.toLowerCase(); }
    catch { return null; }
    if (!allowed.has(host)) return null;
    if (request.headers.origin) {
      let origin;
      try { origin = new URL(request.headers.origin); } catch { return null; }
      if (origin.protocol !== "https:" || !allowed.has(origin.hostname.toLowerCase()) || origin.port) return null;
    }
    const headers = { ...request.headers, host: `127.0.0.1:${upstreamPort}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${upstreamPort}`;
    delete headers.forwarded;
    for (const key of Object.keys(headers)) {
      if (key.startsWith("x-forwarded-")) delete headers[key];
    }
    return headers;
  }
  const server = http.createServer((request, response) => {
    const headers = headersFor(request);
    if (!headers) { response.writeHead(403).end(); return; }
    const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, path: request.url, method: request.method, headers }, (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("upgrade", (request, socket, head) => {
    const headers = headersFor(request);
    if (!headers) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, path: request.url, headers });
    upstream.on("upgrade", (reply, peer, upstreamHead) => {
      socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`);
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        socket.write(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}\r\n`);
      }
      socket.write("\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy());
      peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on("response", (reply) => { socket.end(`HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  return server;
}

if (require.main === module) {
  const hosts = JSON.parse(process.env.HERMES_PROXY_HOSTS || "[]");
  if (!process.env.POD_IP || !hosts.some(Boolean)) throw new Error("Hermes proxy requires Pod IP and configured hostnames");
  createProxy({ hosts }).listen(9119, process.env.POD_IP);
}
module.exports = { createProxy };
