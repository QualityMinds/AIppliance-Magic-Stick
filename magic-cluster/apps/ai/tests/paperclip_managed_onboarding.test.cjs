// SPDX-License-Identifier: BUSL-1.1
"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { patchOnboarding, prepare } = require("../../instances/paperclip/files/managed-onboarding.cjs");

test("the UI overlay rejects unrecognized upstream inputs and unsafe model identifiers", (t) => {
  assert.throws(() => patchOnboarding("", "litellm/qwen35"), /function not found/);
  assert.throws(() => patchOnboarding("", "openai/remote-model"), /configured LiteLLM model/);
  assert.throws(() => patchOnboarding("", 'litellm/a"'), /configured LiteLLM model/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-unexpected-ui-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  fs.mkdirSync(path.join(input, "assets"), { recursive: true });
  fs.writeFileSync(path.join(input, "assets/index-DAL4r-07.js"), "different upstream build");
  assert.throws(() => prepare(input, output, "litellm/qwen35"), /checksum changed/);
  assert.equal(fs.existsSync(output), false);
});

const upstream = process.env.PAPERCLIP_PINNED_UI_DIST;
const playwrightModule = process.env.PAPERCLIP_PLAYWRIGHT_MODULE || "playwright";
const company = {
  id: "10000000-0000-4000-8000-000000000001", name: "Fixture", issuePrefix: "FIX",
  description: "", status: "active", createdAt: "2026-01-01T00:00:00Z",
};
const agent = {
  id: "20000000-0000-4000-8000-000000000002", companyId: company.id,
  name: "Fixture Agent", role: "general", status: "idle", adapterType: "opencode_local",
};
const catalog = [
  { id: "litellm/qwen35", label: "Fixture Qwen" },
  { id: "litellm/local-alternative", label: "Alternative local model" },
  { id: "openai/not-managed", label: "Unmanaged model" },
];

async function fixture(root, models, probeStatus) {
  const probes = [], hires = [], requests = [];
  let companyCreated = false;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    const send = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (route.startsWith("/api/")) {
      requests.push(req.method + " " + route);
      if (req.method === "POST") {
        let content = "";
        for await (const chunk of req) content += chunk;
        const body = JSON.parse(content || "{}");
        if (route === "/api/companies") {
          companyCreated = true;
          return send(company, 201);
        }
        if (route.endsWith("/test-environment")) {
          probes.push(body);
          return send({ status: probeStatus, checks: [] });
        }
        if (route.endsWith("/agent-hires")) {
          hires.push(body);
          return send({ agent: { ...agent, adapterConfig: body.adapterConfig } }, 201);
        }
        return send({ error: "Unrecognized fixture mutation" }, 404);
      }
      if (route === "/api/health") return send({ status: "ok", deploymentMode: "local_trusted" });
      if (route === "/api/companies") return send(companyCreated ? [company] : []);
      if (route === "/api/adapters") return send([
        { type: "opencode_local", disabled: false },
        { type: "codex_local", disabled: true },
        { type: "claude_local", disabled: true },
      ]);
      if (route.endsWith("/opencode_local/models")) return send(models);
      if (route.endsWith("/auth-signal")) return send({ status: "present" });
      if (route.includes("/instance/")) return send({});
      if (route.includes("get-session")) return send(null);
      return send([]);
    }
    const asset = path.resolve(root, "." + route);
    const file = asset.startsWith(root + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile() ?
      asset : path.join(root, "index.html");
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)];
    res.writeHead(200, type ? { "Content-Type": type } : {});
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: "http://127.0.0.1:" + server.address().port, probes, hires, requests };
}

test("pinned Paperclip wizard offers managed OpenCode without a browser credential", {
  skip: upstream ? false : "Set PAPERCLIP_PINNED_UI_DIST to the official AMD64 image's ui/dist",
}, async (t) => {
  const { chromium } = require(playwrightModule);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-managed-ui-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const patched = path.join(temp, "dist");
  prepare(upstream, patched, "litellm/qwen35");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  async function open(root, models, probeStatus, viewport = { width: 1200, height: 860 }) {
    const run = await fixture(root, models, probeStatus);
    t.after(() => new Promise((resolve) => run.server.close(resolve)));
    const context = await browser.newContext({ reducedMotion: "reduce", viewport });
    t.after(() => context.close());
    await context.route("**/*", (route) => new URL(route.request().url()).origin === run.url ?
      route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.setDefaultTimeout(10000);
    await page.goto(run.url + "/onboarding");
    try {
      const companyName = page.getByPlaceholder("e.g. Northwind Labs");
      await companyName.fill(company.name);
      await companyName.press("Enter");
      const agentName = page.locator("#onboarding-agent-name");
      await agentName.fill(agent.name);
      await agentName.press("Enter");
      await page.getByText("Connect a model", { exact: true }).last().waitFor();
    } catch (err) {
      throw new Error("Synthetic onboarding setup did not load: " + JSON.stringify({
        location: new URL(page.url()).pathname,
        body: (await page.locator("body").innerText()).slice(0, 700),
        requests: run.requests,
        errors,
      }), { cause: err });
    }
    return { ...run, page, errors };
  }

  const original = await open(upstream, catalog, "pass");
  assert.equal(await original.page.getByRole("radio", { name: /OpenCode/ }).count(), 0);
  assert.equal(await original.page.getByRole("button", { name: /Next/ }).isEnabled(), false);

  const working = await open(patched, catalog, "pass");
  await working.page.getByRole("radio", { name: /OpenCode/ }).click();
  const picker = working.page.getByRole("combobox", { name: "Magic Stick model" });
  await picker.waitFor();
  assert.equal(await picker.inputValue(), "litellm/qwen35");
  assert.equal(await working.page.getByRole("option", { name: "Unmanaged model" }).count(), 0);
  assert.equal(await working.page.getByPlaceholder("Enter API key here").count(), 0);
  assert.equal(await working.page.getByRole("button", { name: /subscription instead/i }).count(), 0);
  await working.page.getByRole("button", { name: "Connect", exact: true }).click();
  try {
    await working.page.getByRole("button", { name: "Get started", exact: true }).waitFor();
  } catch (err) {
    throw new Error("Synthetic review step did not load: " + JSON.stringify({
      body: (await working.page.locator("body").innerText()).slice(0, 700),
      requests: working.requests,
      errors: working.errors,
      probes: working.probes.length,
      hires: working.hires.length,
    }), { cause: err });
  }
  assert.equal(working.probes.length, 1);
  assert.equal(working.probes[0].adapterConfig.model, "litellm/qwen35");
  assert.equal(working.hires.length, 1);
  assert.equal(working.hires[0].adapterConfig.model, "litellm/qwen35");
  assert.equal(working.hires[0].adapterConfig.env?.OPENAI_API_KEY, undefined);

  const refused = await open(patched, catalog.slice(1), "fail", { width: 390, height: 844 });
  await refused.page.getByRole("radio", { name: /OpenCode/ }).click();
  const alternative = refused.page.getByRole("combobox", { name: "Magic Stick model" });
  await alternative.waitFor();
  const connect = refused.page.getByRole("button", { name: "Connect", exact: true });
  await connect.waitFor();
  assert.equal(await alternative.inputValue(), "");
  assert.equal(await connect.isEnabled(), false);
  await alternative.selectOption("litellm/local-alternative");
  await connect.click();
  await refused.page.getByText(/The environment test failed/).waitFor();
  assert.equal(refused.probes[0].adapterConfig.model, "litellm/local-alternative");
  assert.equal(refused.hires.length, 0);
});
