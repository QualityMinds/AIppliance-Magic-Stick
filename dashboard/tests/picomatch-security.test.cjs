// SPDX-License-Identifier: BUSL-1.1
// Exercise the dependency actually resolved by Vite, not a copied matcher.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {createRequire} = require('node:module');
const {dirname, join, resolve} = require('node:path');
const {test} = require('node:test');

const workspace = resolve(__dirname, '..');
const web = createRequire(join(workspace, 'apps/web/package.json'));
const vite = createRequire(web.resolve('vite'));
const entry = vite.resolve('picomatch');
const picomatch = require(entry);

const boundedMatch = fixture => {
  const result = spawnSync(process.execPath, ['-e', `
    const pm = require(process.argv[1]);
    const fixture = JSON.parse(process.argv[2]);
    const matcher = pm(fixture.pattern, fixture.options || {});
    console.log(JSON.stringify({matched: matcher(fixture.input), literal: matcher(fixture.pattern)}));
  `, entry, JSON.stringify(fixture)], {encoding: 'utf8', timeout: 2000, maxBuffer: 4096});
  assert.equal(result.error, undefined, 'A short repeated-extglob input exceeded its isolated process budget');
  assert.equal(result.status, 0, 'The matcher subprocess failed');
  return JSON.parse(result.stdout);
};

test('GHSA-fc5q-39xc-vjpf single-branch repeated extglob ReDoS is bounded', () => {
  const result = boundedMatch({pattern: '+(*a)', input: 'a'.repeat(80) + '!'});
  assert.deepEqual(result, {matched: false, literal: true});
});

for (const [name, options] of [
  ['Windows', {windows: true}], ['Bash', {bash: true}],
  ['capturing', {capture: true}], ['dotfiles', {dot: true}],
  ['disabled fast paths', {fastpaths: false}], ['bounded recursion', {maxExtglobRecursion: 1}],
]) test(`the repeated-extglob guard remains active with ${name} options`, () => {
  assert.deepEqual(boundedMatch({pattern: '+(*a)', input: 'a'.repeat(80) + '!', options}),
    {matched: false, literal: true});
});

test('malformed POSIX prefixes do not add unbounded lookahead', () => {
  const pattern = '+(' + '[[:'.repeat(6000) + '*a)';
  const result = spawnSync(process.execPath, ['-e',
    'require(process.argv[1]).makeRe(process.argv[2]); console.log("bounded");', entry, pattern],
  {encoding: 'utf8', timeout: 2000, maxBuffer: 4096});
  assert.equal(Boolean(result.error), false, 'Malformed bracket parsing exceeded its isolated process budget');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'bounded');
});

const attacks = [
  ['one-or-more wildcard', '+(*)', 'a'.repeat(80) + '/'],
  ['zero-or-more wildcard', '*(*)', 'a'.repeat(80) + '/'],
  ['zero-or-more wildcard suffix', '*(*a)', 'a'.repeat(80) + '!'],
  ['prefixed repeated extglob', 'prefix+(*a)suffix', 'prefix' + 'a'.repeat(80) + '!suffix'],
  ['bracket suffix', '+(*[ab])', 'a'.repeat(80) + '!'],
  ['wrapped wildcard', '+(@(*a))', 'a'.repeat(80) + '!'],
  ['repeated wildcard before suffix', '+(*)c', 'a'.repeat(80) + '/c'],
  ['mixed repeated branches', '*(a*|b)', 'a'.repeat(80) + '/'],
  ['repeated wildcard with path and suffix', '*/*(W*, *)*Z', 'my/' + 'W, '.repeat(36) + '/Z'],
];
for (const [name, pattern, input] of attacks) test(`bounded repeated-extglob variant: ${name}`, () => {
  assert.deepEqual(boundedMatch({pattern, input}), {matched: false, literal: true});
});

const compatibility = [
  ['recursive TypeScript selection', '**/*.ts', 'src/nested/main.ts', true],
  ['extension rejection', '**/*.ts', 'src/main.tsx', false],
  ['hidden directory default', '**/*.ts', '.cache/main.ts', false],
  ['application directories', 'src/@(api|web)/*.js', 'src/web/main.js', true],
  ['literal repeated alternatives', 'file.+(js|ts)', 'file.jsts', true],
  ['safe repeated literal', '+(ab)', 'abab', true],
  ['safe repeated literal rejection', '+(ab)', 'abab!', false],
  ['safe optional repeated literal', '*(ab)', 'abab', true],
  ['existing safe nested-star reduction', '+(*(a)|*(b))', 'abba', true],
  ['bracket literal star', '+([*])', '***', true],
  ['POSIX class and literal star', '+([[:alpha:]*])', 'abc***', true],
  ['unambiguous nested repetition', '*(f*(o))', 'fooofoofofooo', true],
  ['unambiguous mixed nested repetition', '*(b+(c)d|e*(f)g?|?(h)i@(j|k))', 'egzefffgzbcdij', true],
  ['escaped literal star', '+(\\*)', '***', true],
  ['quoted literal star', '+("*")', '***', true],
  ['escaped star and literal suffix', '+(\\*a)', '*a*a', true],
  ['ordinary negation', '!**/*.test.ts', 'src/main.ts', true],
  ['test exclusion', '!**/*.test.ts', 'src/main.test.ts', false],
];
for (const [name, pattern, input, expected] of compatibility) test(`glob compatibility: ${name}`, () => {
  assert.equal(picomatch.isMatch(input, pattern), expected);
});

test('literal-star recursion retains capture and case options', () => {
  assert.equal(picomatch.isMatch('***', '+([*])', {capture: true}), true);
  assert.equal(picomatch.isMatch('ABab', '+(ab)', {nocase: true}), true);
  assert.equal(picomatch.isMatch('.cache/main.ts', '**/*.ts', {dot: true}), true);
  assert.equal(picomatch.isMatch('src\\main.ts', '**/*.ts', {windows: true}), true);
});

test('the actual web build matcher retains its truthful upstream version', () => {
  assert.equal(require(vite.resolve('picomatch/package.json')).version, '4.0.7');
  const patch = readFileSync(join(workspace, 'patches/picomatch@4.0.7.patch'), 'utf8');
  const expected = patch.match(/^index [0-9a-f]{40}\.\.([0-9a-f]{40}) 100644$/m);
  assert.ok(expected, 'The versioned patch has no exact patched-file identity');
  const source = readFileSync(join(dirname(entry), 'lib/parse.js'));
  const actual = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  assert.equal(actual, expected[1], 'The resolved matcher differs from the reviewed patch');
});
