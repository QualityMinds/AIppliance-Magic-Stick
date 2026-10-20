import type {BrowserContextOptions} from '@playwright/test';

export type HttpsPurpose = 'functional' | 'certificate';

/** Test-purpose policy, not an operator setting or a product TLS override.
 * Functional checks exercise HTTP, authentication and runtime behavior; HAR-01
 * and credential bootstrap deliberately verify the certificate separately.
 * Never replace HTTPS URLs, origin/identity checks or a client's real CA contract.
 */
export function regressionContextOptions(purpose: HttpsPurpose = 'functional'): BrowserContextOptions {
  return {serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: purpose === 'functional'};
}

export const functionalHttpsRequestOptions = Object.freeze({ignoreHTTPSErrors: true});
// Only the regression protocol probe consumes this; never change global agents
// or NODE_TLS_REJECT_UNAUTHORIZED (which would also weaken certificate tests).
export const functionalNodeTlsOptions = Object.freeze({rejectUnauthorized: false});
