// SPDX-License-Identifier: BUSL-1.1
"use strict";

// Compatibility with the verified Paperclip 2026.1001.0 release. Node's
// synchronous loader hooks also cover the sandbox plugin's isolated worker.
// Refuse changed upstream files rather than silently applying a partial patch.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { fileURLToPath } = require("node:url");
const { registerHooks, syncBuiltinESMExports } = require("node:module");
const childProcess = require("node:child_process");

const pluginVersion = "2026.1001.0";
const expectedHashes = {
  manifest: "458653f7d2eb1c1e6d2720d5502a195e61d36dbbca24f5a093b33084e1b611e3",
  plugin: "f8a69398b121e3e9488ecc2388f8efa93de102933fbd7e5ae9a1f70bd99ec601",
};

function pluginPackage(file) {
  if (path.basename(path.dirname(file)) !== "dist") return null;
  const manifest = path.join(path.dirname(path.dirname(file)), "package.json");
  if (!fs.existsSync(manifest)) return null;
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (pkg.name !== "@paperclipai/plugin-kubernetes") return null;
  if (pkg.version !== pluginVersion) {
    throw new Error(`MagicStick requires ${pkg.name}@${pluginVersion}; found ${pkg.version}`);
  }
  return pkg;
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error("Pinned Paperclip compatibility source no longer matches exactly");
  }
  return source.replace(before, after);
}

function transform(kind, source) {
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== expectedHashes[kind]) {
    throw new Error(`Pinned Paperclip ${kind} checksum changed; review the compatibility patch`);
  }
  if (kind === "manifest") {
    // The npm release incorrectly reports an unchanged alpha manifest version.
    // Report its verified package version so an existing PVC installation can
    // be upgraded by the readiness helper instead of being mistaken for ready.
    return replaceOnce(source,
      'const PLUGIN_VERSION = "0.1.0-alpha.1";',
      `const PLUGIN_VERSION = "${pluginVersion}";`);
  }
  source = replaceOnce(source,
    'const cwd = params.workspace.remotePath && params.workspace.remotePath.trim().length > 0\n            ? params.workspace.remotePath.trim()\n            : "/workspace";',
    'const requestedRemotePath = params.workspace.remotePath?.trim() || "/workspace";\n        const cwd = requestedRemotePath === "/tmp" ? "/workspace" : requestedRemotePath;');
  return replaceOnce(source,
    "const execCommand = wrapCommandWithEnv(baseExecCommand, params.env);",
    [
      'const requestedCwd = typeof params.cwd === "string" && params.cwd.trim()',
      '                ? params.cwd',
      '                : typeof lease.metadata?.remoteCwd === "string" && lease.metadata.remoteCwd.trim()',
      '                    ? lease.metadata.remoteCwd : "/workspace";',
      '            const cwd = requestedCwd === "/tmp" ? "/workspace" : requestedCwd;',
      '            if (!cwd.startsWith("/") || cwd.includes("\\0")) {',
      '                throw new Error("Paperclip sandbox cwd must be an absolute path without NUL bytes");',
      '            }',
      '            const execCommand = wrapCommandWithEnv(',
      '                ["/bin/sh", "-c", \'cd -- "$1" && shift && exec "$@"\', "magicstick-cwd", cwd, ...baseExecCommand],',
      '                params.env,',
      '            );',
    ].join("\n"));
}

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context);
    const file = fileURLToPath(url);
    let kind;
    if (["manifest.js", "plugin.js"].includes(path.basename(file)) && pluginPackage(file)) {
      kind = path.basename(file, ".js");
    }
    if (!kind) return nextLoad(url, context);
    return {format: "module", source: transform(kind, fs.readFileSync(file, "utf8")), shortCircuit: true};
  },
});

// Paperclip intentionally starts plugin workers with a small environment and
// explicit execArgv. Pass only this preload to the verified Kubernetes worker;
// preserve that environment boundary and all other plugins' launch arguments.
const originalFork = childProcess.fork;
childProcess.fork = function(modulePath, args, options) {
  const file = modulePath instanceof URL ? fileURLToPath(modulePath) : path.resolve(modulePath);
  if (path.basename(file) === "worker.js" && pluginPackage(file)) {
    if (!Array.isArray(args)) { options = args; args = []; }
    options = {...options, execArgv: ["--require", __filename, ...(options?.execArgv || [])]};
  }
  return originalFork.call(this, modulePath, args, options);
};
syncBuiltinESMExports();

module.exports = { transform, pluginVersion };
