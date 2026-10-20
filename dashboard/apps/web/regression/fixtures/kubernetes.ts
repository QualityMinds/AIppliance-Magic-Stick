/** Token-free synthetic fixture, never an accepted Appliance credential. */
export const kubernetesIdentityOrigin = 'https://identity.example.local';
export function syntheticKubeconfig(user = 'fixture-user') {
  const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----').toString('base64');
  return JSON.stringify({apiVersion: 'v1', kind: 'Config', clusters: [{name: 'fixture', cluster: {
    server: 'https://192.0.2.44:6443', 'certificate-authority-data': ca}}],
    users: [{name: user, user: {exec: {apiVersion: 'client.authentication.k8s.io/v1', command: 'kubectl', args: [
      'oidc-login', 'get-token', '--oidc-issuer-url=' + kubernetesIdentityOrigin + '/realms/fixture',
      '--oidc-client-id=fixture', '--oidc-pkce-method=S256', '--certificate-authority-data=' + ca, '--token-cache-storage=keyring']}}}],
    contexts: [{name: user, context: {cluster: 'fixture', user}}], 'current-context': user});
}
