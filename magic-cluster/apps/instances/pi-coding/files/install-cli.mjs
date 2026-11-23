// SPDX-License-Identifier: BUSL-1.1
// Explicit CLI entry point: ConfigMap projections resolve to timestamped symlinks.
import {install} from './install.mjs';

try {
  await install(process.env.PI_RUNTIME_DIR || '/runtime');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
