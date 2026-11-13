// SPDX-License-Identifier: BUSL-1.1
const assert = require('node:assert/strict');
const test = require('node:test');
const {ensureDataOwner} = require('../../instances/openclaw/files/ensure-data-owner.cjs');

const directory = (uid, gid, overrides = {}) => ({
  uid: BigInt(uid), gid: BigInt(gid), dev: 21n, ino: 42n, isDirectory: () => true, isSymbolicLink: () => false, ...overrides,
});

function filesystem(initial, observed = initial, final = directory(1000, 1000)) {
  const calls = [];
  let snapshots = 0;
  return {calls, constants: {O_RDONLY: 0, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000},
    lstatSync(path) {calls.push(['lstat', path]); return initial;},
    openSync(path, flags) {calls.push(['open', path, flags]); return 8;},
    fstatSync(fd) {calls.push(['fstat', fd]); return snapshots++ === 0 ? observed : final;},
    fchownSync(fd, uid, gid) {calls.push(['fchown', fd, uid, gid]);},
    closeSync(fd) {calls.push(['close', fd]);},
  };
}

test('root-owned data mount is changed once using only a pinned directory descriptor', () => {
  for (const gid of [0, 1000]) {
    const fs = filesystem(directory(0, gid));
    ensureDataOwner(fs);
    assert.deepEqual(fs.calls, [
      ['lstat', '/data'], ['open', '/data', 0x30000], ['fstat', 8],
      ['fchown', 8, 1000, 1000], ['fstat', 8], ['close', 8],
    ]);
  }
});

test('already owned volume is left untouched, even when its mode is private', () => {
  const fs = filesystem(directory(1000, 1000));
  ensureDataOwner(fs);
  assert.deepEqual(fs.calls, [['lstat', '/data']]);
});

test('foreign owners, groups and links are rejected before any mutation', () => {
  for (const item of [directory(2000, 1000), directory(0, 2000), directory(1000, 0),
    directory(0, 1000, {isSymbolicLink: () => true}), directory(0, 1000, {isDirectory: () => false})]) {
    const fs = filesystem(item);
    assert.throws(() => ensureDataOwner(fs), /Unexpected data volume/);
    assert.deepEqual(fs.calls, [['lstat', '/data']]);
  }
});

test('a replaced root or missing safe open flag prevents chown', () => {
  for (const changed of [directory(0, 1000, {ino: 43n}), directory(0, 1000, {dev: 22n}),
    directory(2000, 1000), directory(0, 0), directory(0, 1000, {isDirectory: () => false})]) {
    const fs = filesystem(directory(0, 1000), changed);
    assert.throws(() => ensureDataOwner(fs), /root changed/);
    assert.equal(fs.calls.some(call => call[0] === 'fchown'), false);
    assert.deepEqual(fs.calls.at(-1), ['close', 8]);
  }
  const fs = filesystem(directory(0, 1000));
  fs.constants.O_NOFOLLOW = 0;
  assert.throws(() => ensureDataOwner(fs), /unavailable/);
  assert.deepEqual(fs.calls, [['lstat', '/data']]);
});

test('inode changes above the JavaScript number precision limit are detected', () => {
  const fs = filesystem(directory(0, 1000, {ino: 9007199254740992n}),
    directory(0, 1000, {ino: 9007199254740993n}));
  assert.throws(() => ensureDataOwner(fs), /root changed/);
  assert.equal(fs.calls.some(call => call[0] === 'fchown'), false);
});

test('failure to change or verify ownership stops startup and closes the descriptor', () => {
  const denied = filesystem(directory(0, 1000));
  denied.fchownSync = () => {throw new Error('denied');};
  assert.throws(() => ensureDataOwner(denied), /denied/);
  assert.deepEqual(denied.calls.at(-1), ['close', 8]);
  const changed = filesystem(directory(0, 1000), directory(0, 1000), directory(2000, 1000));
  assert.throws(() => ensureDataOwner(changed), /not restored/);
  assert.deepEqual(changed.calls.at(-1), ['close', 8]);
});
