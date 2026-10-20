// A distinct entrypoint/readiness key prevents old images/operators from
// silently ignoring the new mode and executing their default destructive suite.
if (process.env.REGRESSION_TEST_MODE !== 'non-destructive') throw new Error('Invalid non-destructive test mode.');
await import('./kubernetes.mjs');
