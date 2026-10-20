/** A distinct entrypoint makes older runner images fail closed rather than
 * falling back to their full suite when they do not support recovery yet. */
process.env.REGRESSION_OPERATION = 'recover-lock';
await import('./kubernetes.mjs');
