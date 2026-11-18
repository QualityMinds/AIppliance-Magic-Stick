// SPDX-License-Identifier: BUSL-1.1
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Upstream 2026.1001.0 AMD64 image, also pinned by the instance chart.
const entryFile = "index-DAL4r-07.js";
const preloadFile = "preload-helper-BATLnrmA.js";
const hashes = {
  entry: "582a92da17848f16f41fece88482dcf782d6b68f9990fe23768338ce350da278",
  html: "bacf683d8bb426278dfb46b8888f41592a1a82c6f3703ccf13acad91d3cb2feb",
  preload: "045499e00b1a634114a93b13ccd0bfada8c5b22ebe6c496475743615f316421c",
};
const modelPattern = /^litellm\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");

function verifiedSource(file, expected) {
  const data = fs.readFileSync(file);
  if (sha(data) !== expected) throw new Error("Pinned Paperclip UI checksum changed");
  return data.toString("utf8");
}

function replaceOnce(source, from, to) {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + from.length) >= 0) {
    throw new Error("Pinned Paperclip onboarding source no longer matches exactly");
  }
  return source.slice(0, at) + to + source.slice(at + from.length);
}

function patchOnboarding(source, defaultModel) {
  if (typeof defaultModel !== "string" || !modelPattern.test(defaultModel)) {
    throw new Error("Paperclip onboarding requires a configured LiteLLM model ID");
  }
  // Limit all substitutions to the upstream OnboardingWizard function.
  const start = source.indexOf("function Btt(");
  const end = source.indexOf('},"step-4")', start);
  if (start < 0 || end < 0) throw new Error("Pinned Paperclip onboarding function not found");
  let wizard = source.slice(start, end);
  const model = JSON.stringify(defaultModel);

  // OpenCode must still be returned by the server as enabled and visible.
  wizard = replaceOnce(wizard,
    "recommendedAdapters:qt.filter(cs=>cs.recommended),moreAdapters:qt.filter(cs=>!cs.recommended)",
    'recommendedAdapters:qt.filter(cs=>cs.recommended||cs.type==="opencode_local"),moreAdapters:qt.filter(cs=>!cs.recommended&&cs.type!=="opencode_local")');
  // Managed OpenCode uses the Pod's instance-scoped LiteLLM credential. Never
  // replace it with a personal key or send it to the browser.
  wizard = replaceOnce(wizard, "lt=ze.options.find(qt=>qt.id===Oe),Rt=Re??(",
    'lt=W==="opencode_local"?void 0:ze.options.find(qt=>qt.id===Oe),Rt=W==="opencode_local"?"api":Re??(');
  wizard = replaceOnce(wizard, 'if(Rt==="api"&&!lt&&Zt.trim()',
    'if(W!=="opencode_local"&&Rt==="api"&&!lt&&Zt.trim()');

  // Use Paperclip's existing authenticated adapter-model query and require the
  // selected LiteLLM ID to exist in its current result, even on keyboard submit.
  wizard = replaceOnce(wizard, "}),tn=Ew()(W),",
    '}),msOpenCode=W==="opencode_local",msModels=(Array.isArray(Us)?Us:[]).filter(qt=>qt&&typeof qt.id==="string"&&' +
    modelPattern.toString() +
    '.test(qt.id)),msModelReady=!wn&&!or&&!bn&&msModels.some(qt=>qt.id===_e),tn=Ew()(W),');
  wizard = replaceOnce(wizard, "ir=Jn&&!it&&!ze.loading,",
    "ir=Jn&&!it&&!ze.loading&&(!msOpenCode||msModelReady),");
  wizard = replaceOnce(wizard, 'disabled:!ir||Rt==="api"&&!Zt.trim()&&!lt',
    'disabled:!ir||!msOpenCode&&Rt==="api"&&!Zt.trim()&&!lt');
  wizard = replaceOnce(wizard, '(0,t.jsx)(efe,{mode:Rt,onChange:je})',
    '!msOpenCode&&ba.some(qt=>qt.type!=="opencode_local")&&(0,t.jsx)(efe,{mode:Rt,onChange:je})');

  wizard = replaceOnce(wizard, 'qt==="opencode_local"?ce("openai/gpt-5.2-codex")',
    'qt==="opencode_local"?ce(' + model + ')');
  wizard = replaceOnce(wizard, 'if(cs==="opencode_local"){ce(wKe);return}',
    'if(cs==="opencode_local"){ce(' + model + ');return}');
  wizard = replaceOnce(wizard, 'const $s=Us??[];if(!$s.some(Un=>Un.id===es))',
    'const $s=msModels;if(!$s.some(Un=>Un.id===es))');

  // Display the real catalog and no manual credential field for this adapter.
  // The original model check, environment probe and hire handler stay in use.
  const picker = 'msOpenCode?(0,t.jsxs)("label",{className:"grid gap-2",children:[' +
    '(0,t.jsx)("span",{children:"Magic Stick model"}),' +
    '(0,t.jsxs)("select",{"aria-label":"Magic Stick model",className:"w-full rounded-md border border-border bg-card p-2",' +
    'value:msModels.some(qt=>qt.id===_e)?_e:"",onChange:qt=>ce(qt.target.value),disabled:or||bn||B||it,children:[' +
    '(0,t.jsx)("option",{value:"",disabled:!0,children:"Choose an available model"}),' +
    'msModels.map(qt=>(0,t.jsx)("option",{value:qt.id,children:qt.label||qt.id},qt.id))]}),' +
    '(0,t.jsx)("span",{className:"text-sm text-muted-foreground",children:wn?"Magic Stick models could not be loaded.":or||bn?"Loading Magic Stick models…":' +
    'msModels.length?"Uses the configured Magic Stick connection. No subscription needed.":"No Magic Stick chat model is currently available."})]}):';
  wizard = replaceOnce(wizard, '):Rt==="api"?(0,t.jsxs)(',
    '):' + picker + 'Rt==="api"?(0,t.jsxs)(');
  return source.slice(0, start) + wizard + source.slice(end);
}

function prepare(input, output, defaultModel) {
  const assets = path.join(input, "assets");
  const entry = patchOnboarding(verifiedSource(path.join(assets, entryFile), hashes.entry), defaultModel);
  const html = verifiedSource(path.join(input, "index.html"), hashes.html);
  const preload = verifiedSource(path.join(assets, preloadFile), hashes.preload);
  // Vite serves immutable assets. Put all imports, including lazy chunks that
  // import the entry back, under a versioned path rather than reusing its URL.
  const prefix = "magicstick-" + sha(entry + fs.readFileSync(__filename, "utf8")).slice(0, 20);
  const versioned = path.join(output, "assets", prefix);
  fs.cpSync(input, output, { recursive: true });
  fs.cpSync(assets, versioned, { recursive: true });
  fs.writeFileSync(path.join(versioned, entryFile), entry);
  fs.writeFileSync(path.join(versioned, preloadFile), replaceOnce(preload,
    'function(a){return"/"+a}',
    'function(a){return a.startsWith("assets/")?"/assets/' + prefix + '/"+a.slice(7):"/"+a}'));
  fs.writeFileSync(path.join(output, "index.html"), html.replaceAll('"/assets/', '"/assets/' + prefix + '/'));
}

if (require.main === module) {
  prepare("/app/ui/dist", "/onboarding-ui", process.env.PAPERCLIP_DEFAULT_OPENCODE_MODEL);
}

module.exports = { patchOnboarding, prepare };
