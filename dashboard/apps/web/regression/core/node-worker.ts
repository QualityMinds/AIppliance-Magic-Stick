import {HarnessError} from './errors.ts';

/** Select the TypeScript execution mode supported by the active Node runtime. */
export function typeScriptWorkerArgs(filename: string) {
  if (process.allowedNodeEnvironmentFlags.has('--experimental-transform-types')) {
    return ['--experimental-transform-types', filename];
  }
  if (process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')) {
    return ['--experimental-strip-types', filename];
  }
  throw new HarnessError('CONFIG');
}
