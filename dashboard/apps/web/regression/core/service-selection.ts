/** Only the fixed, server-validated service profile opts into the separate
 * service campaign. Ordinary Phase 5 and retained fixtures stay deferred. */
export const serviceRegressionEnabled = (selection:unknown=process.env.REGRESSION_DIAGNOSTIC_SELECTION,
  mode:unknown=process.env.REGRESSION_MODE) => selection === 'services' && (mode===undefined||mode==='services');

/** Scoped service setup must not introduce license trust or restart the API.
 * Existing pending-receipt recovery runs independently before this new work. */
export async function withNewTestLicenseFixtures(prepare:()=>Promise<void>,resumePending=false) {
  if(serviceRegressionEnabled()&&!resumePending)return false;
  await prepare();return true;
}
