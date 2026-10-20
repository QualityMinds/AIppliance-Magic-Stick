// SPDX-License-Identifier: BUSL-1.1
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { test } = require("node:test");
const { createProxy } = require("../../instances/hermes/files/dashboard-proxy.cjs");

function get(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (reply) => {
      let body = "";
      reply.on("data", (chunk) => { body += chunk; });
      reply.on("end", () => resolve({ status: reply.statusCode, body }));
    }).on("error", reject);
  });
}

test("Hermes proxy retains session headers and translates only trusted hosts/origins", async (t) => {
  const upstream = http.createServer((request, response) => {
    response.end(JSON.stringify(request.headers));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createProxy({ hosts: ["hermes.example.local"], upstreamPort: upstream.address().port });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const response = await get(url, {
    Host: "hermes.example.local", Origin: "https://hermes.example.local",
    "X-Hermes-Session-Token": "synthetic-session", "X-Forwarded-Host": "untrusted.example.com",
  });
  assert.equal(response.status, 200);
  const headers = JSON.parse(response.body);
  assert.equal(headers.host, `127.0.0.1:${upstream.address().port}`);
  assert.equal(headers.origin, `http://127.0.0.1:${upstream.address().port}`);
  assert.equal(headers["x-hermes-session-token"], "synthetic-session");
  assert.equal(headers["x-forwarded-host"], undefined);
  for (const invalid of [
    { Host: "other.example.com" },
    { Host: "hermes.example.local", Origin: "https://attacker.example.com" },
    { Host: "hermes.example.local", Origin: "http://hermes.example.local" },
    { Host: "hermes.example.local", Origin: "https://hermes.example.local:444" },
  ]) assert.equal((await get(url, invalid)).status, 403);
});

test("Hermes proxy preserves a WebSocket upgrade and bidirectional bytes", async (t) => {
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers["x-hermes-session-token"], "synthetic-session");
    assert.match(request.headers.origin, /^http:\/\/127\.0\.0\.1:/);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (data) => socket.end(data));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createProxy({ hosts: ["hermes.example.local"], upstreamPort: upstream.address().port });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.close(); upstream.close(); });
  await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, "127.0.0.1", () => {
      socket.write("GET /api/ws HTTP/1.1\r\nHost: hermes.example.local\r\nOrigin: https://hermes.example.local\r\nX-Hermes-Session-Token: synthetic-session\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("WebSocket fixture timed out")); });
    let upgraded = false;
    socket.on("error", reject);
    socket.on("data", (data) => {
      if (!upgraded) { assert.match(data.toString(), /^HTTP\/1.1 101/); upgraded = true; socket.write("synthetic-frame"); }
      else { assert.equal(data.toString(), "synthetic-frame"); socket.destroy(); resolve(); }
    });
  });
});
