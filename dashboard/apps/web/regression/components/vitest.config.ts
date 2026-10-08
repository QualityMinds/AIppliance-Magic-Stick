import {mergeConfig} from 'vite';
import {tmpdir} from 'node:os';
import {basename, dirname, resolve, sep} from 'node:path';
import dashboardConfig from '../../vite.config.ts';
import {requireSafe} from '../core/errors.ts';

// Keep the owning component suite/config, but never write into the read-only
// image. Each invocation supplies its own ephemeral directory under /tmp.
const cacheDir = process.env.REGRESSION_UNIT_CACHE_DIR;
const temporaryRoot = resolve(tmpdir());
const resolvedCache = cacheDir ? resolve(cacheDir) : '';
requireSafe(Boolean(resolvedCache && resolvedCache.startsWith(temporaryRoot + sep) &&
  /^magicstick-units-[a-zA-Z0-9]+$/.test(basename(dirname(resolvedCache))) && basename(resolvedCache) === 'cache'), 'CONFIG');

export default mergeConfig(dashboardConfig, {cacheDir: resolvedCache, test: {cache: false, includeTaskLocation: true}});
