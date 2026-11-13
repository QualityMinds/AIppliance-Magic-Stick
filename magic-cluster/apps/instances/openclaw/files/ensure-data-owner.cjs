// SPDX-License-Identifier: BUSL-1.1
// The operator mounts this instance's data PVC at /data. OpenClaw's state
// directory is that mount root, which fsGroup alone may leave owned by root.
// Never recurse or follow a link: a changed or foreign owner is not ours.
function ensureDataOwner(fs) {
  const target = '/data';
  const expectedUid = 1000;
  const expectedGid = 1000;
  // Preserve the full device and inode identifiers when comparing snapshots.
  const initial = fs.lstatSync(target, {bigint: true});
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('Unexpected data volume root');
  if (initial.uid === 1000n && initial.gid === 1000n) return;
  if (initial.uid !== 0n || ![0n, 1000n].includes(initial.gid)) throw new Error('Unexpected data volume owner');
  const {O_RDONLY, O_DIRECTORY, O_NOFOLLOW} = fs.constants;
  if (!O_DIRECTORY || !O_NOFOLLOW) throw new Error('Safe directory opening is unavailable');
  const fd = fs.openSync(target, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd, {bigint: true});
    if (!current.isDirectory() || current.dev !== initial.dev || current.ino !== initial.ino ||
        current.uid !== initial.uid || current.gid !== initial.gid) throw new Error('Data volume root changed');
    fs.fchownSync(fd, expectedUid, expectedGid);
    const verified = fs.fstatSync(fd, {bigint: true});
    if (!verified.isDirectory() || verified.dev !== initial.dev || verified.ino !== initial.ino ||
        verified.uid !== 1000n || verified.gid !== 1000n) throw new Error('Data volume owner was not restored');
  } finally {
    fs.closeSync(fd);
  }
}
module.exports = {ensureDataOwner};
