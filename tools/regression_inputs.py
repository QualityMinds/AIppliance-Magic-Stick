"""Guided private regression setup, with explicit test-installation consent.

Credentials are never printed. Reviewed lab RBAC, optional local test-license
trust and specifically approved model/license actions are the only bootstrap
writes. No official issuer key or production signing key is touched. Temporary
administrator kubeconfigs are neither copied into test roles nor retained.
"""
import argparse
import base64
from datetime import datetime, timezone
import getpass
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import uuid
import warnings
import zipfile
import io
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, HTTPSHandler, HTTPRedirectHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / 'dashboard/apps/web/regression'
PREPARATION_REASONS = {'TLS', 'AUTH', 'PREREQUISITE', 'IDENTITY', 'API', 'CONFIG', 'PRIVATE_FILE',
                       'CONFLICT', 'LAB', 'LOCK_BUSY', 'LOCK_STALE', 'RECOVERY', 'OWNERSHIP', 'CLEANUP', 'LOCK_LOST', 'DEADLINE', 'UNEXPECTED'}
PREPARATION_STAGES = {'request', 'tls', 'login', 'discovery', 'kubernetes-access', 'oidc-session',
                      'bootstrap-file', 'lab-bootstrap', 'run-recovery', 'license-fixtures', 'license-validation'}
RECOVERED_RUN_IDS = []
PREPARATION_DETAILS = {'ENOENT', 'EACCES', 'ENOSPC', 'TYPE_ERROR', 'SYNTAX_ERROR', 'ERR_FAILED',
                       'ERR_BLOCKED_BY_CLIENT', 'ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED',
                       'ERR_CERT_AUTHORITY_INVALID', 'ERR_HTTP2_PROTOCOL_ERROR'}


class SetupError(Exception):
    def __init__(self, message, outcome='Blocked', code='PREREQUISITE', stage=None, detail=None):
        super().__init__(message)
        self.outcome = outcome
        self.code, self.stage, self.detail = code, stage, detail


def preparation_status(outcome, error=None):
    """One launcher-owned attempt, never raw exceptions, credentials or old facts."""
    filename = os.environ.get('REGRESSION_PREPARATION_STATUS_FILE')
    if not filename:
        return
    path = Path(filename)
    directory = Path(os.environ.get('REGRESSION_PRIVATE_DIR', str(ROOT / '.regression/private'))).absolute()
    if path.parent != directory or not re.fullmatch(r'\.preparation-[a-zA-Z0-9]{6}', path.name):
        raise SetupError('Invalid private preparation diagnostic destination.', code='PRIVATE_FILE')
    value = {'version': 1, 'outcome': outcome if outcome in ['Passed', 'Failed', 'Blocked'] else 'Blocked'}
    if RECOVERED_RUN_IDS:
        value['recoveredRunIds'] = list(RECOVERED_RUN_IDS)
    if error:
        # These fields originate only in this module's fixed diagnostic registry.
        value['reason'] = error.code if error.code in PREPARATION_REASONS else 'PREREQUISITE'
        if error.stage in PREPARATION_STAGES:
            value['setupStage'] = error.stage
        if error.detail in PREPARATION_DETAILS:
            value['detail'] = error.detail
    private_write(path, value)


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077:
        raise SetupError('Use a real private directory (mode 0700).')


def private_read(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 1024 * 1024:
            raise SetupError('A private input must be a regular mode-0600 file, at most 1 MiB.')
        with os.fdopen(fd, 'r', encoding='utf-8', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def private_write(path, content):
    private_directory(path.parent)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise SetupError('Refusing an unsafe private-file destination.')
    fd, temporary = tempfile.mkstemp(prefix='.setup-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content if isinstance(content, str) else json.dumps(content, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def origin(value):
    url = urlsplit(value.strip())
    if url.scheme != 'https' or not url.hostname or url.username or url.password or \
            url.query or url.fragment or url.path not in ('', '/') or re.search(r'[\s\x00]', value):
        raise SetupError('Use an HTTPS origin, without credentials, path, query or fragment.')
    return 'https://' + url.netloc


def saved_input_path(directory, value):
    """Translate the runner's /inputs paths back to this private host directory."""
    path = Path(value)
    if '..' in path.parts:
        raise SetupError('Saved credential paths cannot traverse parent directories.')
    if path.is_absolute() and Path('/inputs') in path.parents:
        return directory / path.relative_to('/inputs')
    return path if path.is_absolute() else directory / path


def hidden_password(label):
    if not sys.stdin.isatty():
        raise SetupError('Enter a new password in an interactive terminal; piped password input is not accepted.')
    try:
        # getpass can fall back to echoed input when terminal echo control
        # fails. Turn its warning into an error before that fallback reads.
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass(label + ': ')
    except getpass.GetPassWarning:
        raise SetupError('Hidden password entry is unavailable; use a terminal with working echo control.') from None


def trust_ca(content, destination, automatic=False):
    if len(content) > 256 * 1024:
        raise SetupError('The selected public CA bundle is too large.')
    certificates = re.findall(r'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----', content)
    if not certificates or len(certificates) >= 20 or 'PRIVATE KEY' in content:
        raise SetupError('A CA bundle must contain certificates only, never a private key.')
    fingerprints = [hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).hexdigest() for cert in certificates]
    print('Selected CA SHA-256 fingerprints: ' + ', '.join(fingerprints))
    if not automatic and input('Verify these against a trusted source; type TRUST to import: ').strip() != 'TRUST':
        raise SetupError('CA import was not approved. Nothing was fetched or trusted automatically.')
    private_write(destination, content)


def import_file(source, destination, ca=False, automatic=False):
    # Reading a selected CA is permitted even if its source is public-readable;
    # credentials must already be private. Neither source is ever chmodded.
    if ca:
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 256 * 1024:
            raise SetupError('Select a regular CA PEM file, not a symlink or large bundle.')
        content = source.read_text(encoding='utf-8')
        trust_ca(content, destination, automatic=automatic)
        return
    else:
        content = private_read(source)
    private_write(destination, content)


def kubectl(kubeconfig, arguments, data=None):
    # No shell, no stderr/raw exceptions forwarded (kubectl may include secrets).
    try:
        result = subprocess.run(
            ['kubectl', '--kubeconfig', str(kubeconfig), '--request-timeout=15s', *arguments],
            input=json.dumps(data) if isinstance(data, dict) else data,
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
            raise SetupError('Kubernetes setup failed; check the selected credentials and permissions privately.')
        return result.stdout
    except (OSError, subprocess.SubprocessError):
        raise SetupError('Kubernetes setup requires a working kubectl and reachable verified cluster.') from None


def appliance_ca_from_kubeconfig(source, identity_origin):
    """Extract only the public OIDC issuer CA from a selected downloaded file.

    `config view` does not execute its credential plugin or contact Kubernetes.
    The cluster CA is deliberately NOT a fallback: it signs a different endpoint.
    """
    private_read(source)
    value = json.loads(kubectl(source, ['config', 'view', '--raw', '--minify', '-o', 'json']))
    users = value.get('users', [])
    plugin = users[0].get('user', {}).get('exec', {}) if len(users) == 1 else {}
    arguments = plugin.get('args', [])
    if plugin.get('command') != 'kubectl' or arguments[:2] != ['oidc-login', 'get-token'] or \
            not all(isinstance(item, str) for item in arguments):
        raise SetupError('Select a Magic Stick downloaded OIDC kubeconfig with a public identity CA, or import a trusted PEM.')
    def argument(prefix):
        values = [item[len(prefix):] for item in arguments if item.startswith(prefix)]
        if len(values) != 1:
            raise SetupError('The selected kubeconfig has a missing or ambiguous identity CA/issuer.')
        return values[0]
    issuer = urlsplit(argument('--oidc-issuer-url='))
    if issuer.scheme != 'https' or issuer.username or issuer.password or issuer.query or issuer.fragment or \
            issuer.path != '/realms/magicstick' or origin('https://' + issuer.netloc) != identity_origin:
        raise SetupError('The downloaded kubeconfig identity issuer does not match the selected Identity origin.')
    content = base64.b64decode(argument('--certificate-authority-data='), validate=True).decode('utf-8')
    if len(content) > 256 * 1024 or 'PRIVATE KEY' in content or '-----BEGIN CERTIFICATE-----' not in content:
        raise SetupError('The downloaded identity CA is missing, oversized or contains private key material.')
    return content


def role_credential(content):
    """Early usability check; live Kubernetes permission review remains mandatory."""
    try:
        value = json.loads(content)
    except ValueError:
        # A conservative YAML hint is not a permission audit. The runner parses
        # the real context and verifies every namespace before any product write.
        plugin = re.search(r'^\s*[\'\"]?(?:exec|auth-provider)[\'\"]?\s*:', content, re.M)
    else:
        if not isinstance(value, dict) or not isinstance(value.get('users'), list) or \
                not all(isinstance(user, dict) and isinstance(user.get('user'), dict) for user in value['users']):
            raise SetupError('Select a valid private kubeconfig for the separate test role.')
        plugin = any(user.get('user', {}).get('exec') or user.get('user', {}).get('auth-provider')
                     for user in value.get('users', []))
    if plugin:
        raise SetupError('Test roles cannot use a downloaded admin/OIDC kubeconfig. Use setup --provision-rbac --bootstrap-kubeconfig PATH to generate separate scoped credentials.')


def token_config(cluster, token, account):
    return {'apiVersion': 'v1', 'kind': 'Config',
            'clusters': [{'name': 'regression-lab', 'cluster': cluster}],
            'users': [{'name': account, 'user': {'token': token}}],
            'contexts': [{'name': 'regression-lab', 'context': {'cluster': 'regression-lab', 'user': account}}],
            'current-context': 'regression-lab'}


def oidc_plugin(source, destination, automatic=False, architecture=None):
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size >= 64 * 1024 * 1024:
        raise SetupError('Select a regular Linux OIDC plugin, not a symlink or oversized binary.')
    with source.open('rb') as stream:
        header = stream.read(20)
        if header[:4] != b'\x7fELF':
            raise SetupError('The plugin must be a Linux ELF executable, not a macOS or Windows binary.')
        if architecture is not None and (architecture not in ['amd64', 'arm64'] or
                header[:6] != b'\x7fELF\x02\x01' or len(header) < 20 or
                int.from_bytes(header[18:20], 'little') != (183 if architecture == 'arm64' else 62)):
            raise SetupError('The OIDC plugin does not match the Linux runner architecture.', 'Failed')
        digest = hashlib.sha256(header)
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    print('Selected Linux plugin SHA-256: ' + digest.hexdigest())
    if not automatic and input('Check the upstream checksum and runner architecture; type TRUST to import: ').strip() != 'TRUST':
        raise SetupError('OIDC plugin import was not approved.')
    private_directory(destination.parent)
    if destination.is_symlink():
        raise SetupError('Refusing a symbolic-link plugin destination.')
    fd, temporary = tempfile.mkstemp(prefix='.plugin-', dir=str(destination.parent))
    try:
        with os.fdopen(fd, 'wb') as target, source.open('rb') as stream:
            shutil.copyfileobj(stream, target)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, 0o700)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return digest.hexdigest()


def additional_fixtures(directory, seed):
    """One-time questions, never a request to hand-author a JSON template.

    External IdP/Realtime adapters are reviewed bundles, not guessed protocols,
    signed licenses, or invented UI selectors. Existing bundles are retained.
    """
    profile = json.loads(private_read(directory / 'remaining-p0.json')) if (directory / 'remaining-p0.json').exists() else {'version': 1}
    choices = input('Extra one-time fixtures: apps, kubernetes, license, modules, mesh (comma-separated; blank keeps existing): ').strip()
    selected = set(choices.split(',')) if choices else set()
    if selected - {'apps', 'kubernetes', 'license', 'modules', 'mesh'}:
        raise SetupError('Unknown one-time fixture section.')
    if 'apps' in selected:
        fixtures = []
        hostname = urlsplit(seed['dashboardUrl']).hostname
        old = {item['type']: item for item in profile.get('applications', {}).get('fixtures', [])}
        for kind in ['openclaw', 'hermes', 'paperclip', 'kubeopencode', 'odysseus']:
            fixture = {'type': kind}
            for field, label in [('originTemplate', 'HTTPS origin with {name}'), ('promptLabel', 'Accessible prompt label'),
                                 ('sendButton', 'Accessible send button name'), ('responseSelector', 'Response CSS selector')]:
                default = old.get(kind, {}).get(field, '')
                if field == 'originTemplate' and not default:
                    default = 'https://{name}.' + kind + '.' + hostname
                answer = input(kind + ': ' + label + ' [keep saved/default]: ').strip() or default
                if not answer or 'CHANGEME' in answer or '\x00' in answer:
                    raise SetupError('Review actual shipped application controls once; missing adapters cannot be invented.')
                fixture[field] = answer
            fixture['responseMarker'] = old.get(kind, {}).get('responseMarker', 'REGRESSION')
            fixtures.append(fixture)
        profile['applications'] = {'cleanerKubeconfig': '/inputs/app-cleaner.kubeconfig', 'fixtures': fixtures}
        if not (directory / 'app-cleaner.kubeconfig').exists():
            import_file(Path(input('Private app-intent cleaner kubeconfig path: ').strip()).expanduser(), directory / 'app-cleaner.kubeconfig')
    if 'kubernetes' in selected:
        source = Path(input('Linux kubectl-oidc_login binary path: ').strip()).expanduser()
        sha = oidc_plugin(source, directory / 'kubectl-oidc_login')
        profile['kubernetes'] = {'approveAdminGrant': False, 'plugin': {'filename': '/inputs/kubectl-oidc_login', 'sha256': sha}}
    if 'license' in selected:
        print('Use externally issued signed test licenses bound to this installation. No signing key is imported.')
        for kind in ['valid', 'expired', 'wrong-installation', 'tampered']:
            filename = 'license-' + kind + '.license'
            answer = input('Private ' + kind + ' license path [keep saved]: ').strip()
            if answer:
                import_file(Path(answer).expanduser(), directory / filename)
            else:
                private_read(directory / filename)
        profile['license'] = {'approveLicenseReplacement': False, 'allowFirstActivation': False,
            'validFile': '/inputs/license-valid.license', 'invalidFiles': ['/inputs/license-' + kind + '.license' for kind in ['expired', 'wrong-installation', 'tampered']],
            'restart': {'approveApiRestart': False, 'kubeconfig': '/inputs/api-restarter.kubeconfig'}}
    if 'modules' in selected:
        identifier = input('Reviewed non-critical optional module ID with an existing disabled intent: ').strip()
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', identifier):
            raise SetupError('Use a catalog module ID, not a command or path.')
        profile['modules'] = {'approveOptionalModule': False, 'id': identifier, 'parameters': {}}
        identifier = input('Reviewed advertised alternate AMD profile ID (blank leaves that gate blocked): ').strip()
        if identifier:
            profile['moduleProfile'] = {'approveTemporaryProfile': False, 'profileId': identifier, 'allowExperimental': False}
    if 'mesh' in selected:
        answer = input('Private peer lab.json path (credentials must already be available under /inputs): ').strip()
        import_file(Path(answer).expanduser(), directory / 'peer-lab.json')
        enrollment = origin(input('Reachable Mesh enrollment HTTPS origin: '))
        profile['mesh'] = {'approveTwoAppliances': False, 'approveGpuTransitions': False,
                           'peerConfig': '/inputs/peer-lab.json', 'enrollmentOrigin': enrollment}
    # Consent belongs to a future named prepare action, not to filling a form.
    private_write(directory / 'remaining-p0.json', profile)
    print('Reviewed fixture values saved. New operation approvals remain off.')


def host_mapping(directory, seed, confirmed=False):
    names = {urlsplit(seed[field]).hostname for field in ['dashboardUrl', 'identityUrl', 'inferenceUrl', 'kubernetesApiUrl'] if seed.get(field)}
    names.update(urlsplit(origin(value)).hostname for value in seed.get('extraOrigins', []))
    if not any(name.endswith('.local') for name in names):
        return
    if not confirmed and input('Create private Docker hostname mappings using this computer\'s current DNS? [Y/n]: ').strip().lower() == 'n':
        return
    hosts = {}
    for name in sorted(names):
        if not name.endswith('.local'):
            continue  # Leave public/normal DNS and HA endpoints to normal resolution.
        try:
            ipaddress.ip_address(name)
            continue  # Literal Kubernetes addresses do not need DNS overrides.
        except ValueError:
            pass
        addresses = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
        values = {item[4][0] for item in addresses}
        if len(values) != 1:
            raise SetupError('DNS is unavailable or ambiguous; inspect lab networking, never choose an arbitrary appliance.')
        hosts[name] = values.pop()
    # JSON is a YAML subset. Both services must use the same reviewed mappings;
    # the source remains private and is never printed in the console.
    private_write(directory / 'compose.override.yaml', {'services': {
        name: {'extra_hosts': hosts} for name in ['regression', 'prepare', 'setup-api']}})
    print('Private hostname mappings saved for setup, preparation and test services; verified TLS and identity pins still apply.')


def application_dns(directory, seed, profile):
    """Per-instance routes cannot be enumerated before test names exist. Use
    one reviewed private Chromium suffix map to the verified lab's current IP.
    """
    host = urlsplit(seed['dashboardUrl']).hostname
    if not host.endswith('.local'):
        return
    suffixes = set()
    for fixture in profile.get('applications', {}).get('fixtures', []):
        template = fixture.get('originTemplate', '')
        if template.startswith('https://{name}.'):
            suffix = template[len('https://{name}.'):]
            if suffix.endswith('.' + host) and re.fullmatch(r'[a-z0-9][a-z0-9.-]+', suffix):
                suffixes.add(suffix)
    mappings = []
    if suffixes and yes_no('Map reviewed per-instance application .local hostnames to this appliance inside Chromium (verified TLS remains required)?', True):
        addresses = {item[4][0] for item in socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)}
        if len(addresses) != 1:
            raise SetupError('The appliance DNS address is unavailable/ambiguous; no arbitrary application address was selected.')
        address = addresses.pop()
        mappings = [{'suffix': suffix, 'address': address} for suffix in sorted(suffixes)]
    private_write(directory / 'browser-dns.json', {'version': 1, 'mappings': mappings})


def bootstrap(kubeconfig, directory, api_restart=False, expected_uid=None, license_baseline=False):
    private_read(kubeconfig)  # Reject public-readable bootstrap credentials.
    selected = json.loads(kubectl(kubeconfig, ['config', 'view', '--raw', '--minify', '--flatten', '-o', 'json']))
    clusters = selected.get('clusters', [])
    if len(clusters) != 1:
        raise SetupError('Select exactly one bootstrap Kubernetes context.')
    cluster = clusters[0]['cluster']
    if cluster.get('insecure-skip-tls-verify') or not cluster.get('certificate-authority-data'):
        raise SetupError('The bootstrap context must verify TLS with an embedded cluster CA.')
    origin(cluster.get('server', ''))
    if set(cluster) - {'server', 'certificate-authority-data', 'tls-server-name'}:
        raise SetupError('Unsupported cluster transport; do not import proxies or insecure overrides.')
    appliances = json.loads(kubectl(kubeconfig, ['get', 'appliances.appliance.magicstick.dev', '-A', '-o', 'json']))['items']
    if len(appliances) != 1:
        raise SetupError('Bootstrap requires one unambiguous appliance, not a shared multi-appliance cluster.')
    metadata = appliances[0]['metadata']
    uid = metadata['uid']
    if expected_uid is not None and uid != expected_uid:
        raise SetupError('The Kubernetes Appliance UID differs from authenticated Dashboard discovery. No lab grants were applied.')
    if metadata.get('namespace') != 'ai-system' or metadata.get('name') != 'local' or not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', uid):
        raise SetupError('The reviewed bootstrap manifests target Appliance/local in ai-system only.')
    leases = json.loads(kubectl(kubeconfig, ['get', 'leases.coordination.k8s.io', '-A', '-o', 'json']))['items']
    existing = next((item for item in leases if item['metadata'].get('namespace') == 'magicstick-regression' and
                     item['metadata'].get('name') == 'lab-lock'), None)
    if existing and (existing.get('spec', {}).get('holderIdentity') or
                     existing['metadata'].get('labels', {}).get('regression.magicstick.dev/appliance-uid') != uid):
        raise SetupError('The lab Lease is busy or belongs to another appliance; it is never reset or stolen.')
    names = ['lab-rbac.example.yaml', 'lab-rbac-model-cleaner.example.yaml',
             'lab-rbac-gpu-observer.example.yaml', 'lab-rbac-administration.example.yaml']
    if license_baseline:
        names.append('lab-rbac-license-resetter.example.yaml')
    documents = []
    for name in names:
        for document in re.split(r'^---\s*$', (EXAMPLES / name).read_text(), flags=re.M):
            if not document.strip():
                continue
            # Keep an existing lease untouched. Its resourceVersion/holder is
            # owned by the harness, never by this setup apply.
            if existing and re.search(r'^kind: Lease$', document, re.M):
                continue
            if not api_restart and 'regression-api-restarter' in document:
                continue
            documents.append(document.replace('CHANGEME', uid).strip())
    manifest = '\n---\n'.join(documents) + '\n'
    private_write(directory / 'bootstrap-rbac.yaml', manifest)
    print('Review .regression/inputs/bootstrap-rbac.yaml: read-only observer, one Lease, separate intent cleaners.'
          + (' API-Pod restarter is included.' if api_restart else ' No API-Pod restarter.')
          + (' Exact license-document reset/restore grant is included.' if license_baseline else ' No license reset grant.'))
    print('Appliance UID to verify against your intended lab: ' + uid)
    if input('Type that appliance UID to apply ONLY these lab grants and issue 24-hour tokens: ').strip() != uid:
        raise SetupError('Bootstrap was not approved; no Kubernetes objects were changed.')
    kubectl(kubeconfig, ['apply', '--dry-run=server', '-f', '-'], manifest)
    kubectl(kubeconfig, ['apply', '-f', '-'], manifest)
    accounts = {'observer.yaml': 'regression-observer', 'locker.yaml': 'regression-locker',
                'model-cleaner.yaml': 'regression-model-cleaner', 'app-cleaner.kubeconfig': 'regression-app-cleaner'}
    if api_restart:
        accounts['api-restarter.kubeconfig'] = 'regression-api-restarter'
    if license_baseline:
        accounts['license-resetter.kubeconfig'] = 'regression-license-resetter'
    expires, credentials = {}, {}
    for filename, account in accounts.items():
        request = {'apiVersion': 'authentication.k8s.io/v1', 'kind': 'TokenRequest',
                   'spec': {'expirationSeconds': 86400}}
        response = json.loads(kubectl(kubeconfig,
            ['create', '--raw', '/api/v1/namespaces/magicstick-regression/serviceaccounts/' + account + '/token', '-f', '-'], request))
        status = response.get('status', {})
        token, expiration = status.get('token'), status.get('expirationTimestamp')
        if not isinstance(token, str) or not token or len(token) > 32768 or re.search(r'[\s\x00]', token) or not isinstance(expiration, str):
            raise SetupError('Kubernetes did not issue a bounded service-account credential.')
        try:
            timestamp = datetime.fromisoformat(expiration.replace('Z', '+00:00'))
            if timestamp.tzinfo is None or not 0 < (timestamp - datetime.now(timezone.utc)).total_seconds() <= 86460:
                raise ValueError()
        except ValueError:
            raise SetupError('Kubernetes returned an expired or overlong test credential; no administrator fallback is retained.') from None
        credentials[filename] = token_config(cluster, token, account)
        expires[filename] = expiration
    for filename, content in credentials.items():
        private_write(directory / filename, content)
    private_write(directory / 'credential-expiry.json', {'version': 1, 'expires': expires})
    print('Separate short-lived credentials saved. Re-run approved setup to renew them; no admin fallback is retained.')


def tls_context(ca=None):
    return ssl.create_default_context(cafile=str(ca) if ca else None)


def verified_identity(dashboard, ca=None):
    """Discover the shipped Keycloak login through verified redirects BEFORE
    sending credentials. No fetched certificate becomes a trust anchor.
    """
    url = dashboard
    for _ in range(8):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise SetupError('Dashboard login discovery rejected an unsafe redirect.')
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, context=tls_context(ca), timeout=8)
        try:
            connection.request('GET', (parsed.path or '/') + ('?' + parsed.query if parsed.query else ''),
                               headers={'Accept': 'text/html'})
            response = connection.getresponse()
            if parsed.path == '/realms/magicstick/protocol/openid-connect/auth' and response.status == 200:
                return origin('https://' + parsed.netloc)
            location = response.getheader('Location')
            if response.status not in (301, 302, 303, 307, 308) or not location or len(location) > 16384:
                raise SetupError('The verified Dashboard did not lead to the supported Magic Stick identity login.')
            url = urljoin(url, location)
        finally:
            connection.close()
    raise SetupError('Dashboard identity discovery exceeded the bounded redirect chain.')


def keychain_appliance_ca(dashboard):
    """Mac-only convenience: inspect PUBLIC local certificates, never keys or
    unverified server certificates. Only return a CA which verifies this host;
    the user must still approve its fingerprint before Docker trusts it.
    """
    if sys.platform != 'darwin':
        return None
    try:
        result = subprocess.run(['/usr/bin/security', 'find-certificate', '-a', '-p'],
                                capture_output=True, text=True, timeout=10)
        if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
            return None
        certificates = re.findall(r'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----', result.stdout)
        if len(certificates) > 200:
            return None
        parsed = urlsplit(dashboard)
        for certificate in certificates:
            try:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.load_verify_locations(cadata=certificate)
                with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=2) as connection:
                    with context.wrap_socket(connection, server_hostname=parsed.hostname):
                        return certificate + '\n'
            except (OSError, ssl.SSLError, ValueError):
                continue
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def setup_api(directory, seed, mode, reviewed=None, approve_admin=False):
    """Use the already-built Linux runner; never auto-build/pull or pass secrets
    via arguments/environment. Credentials cross only the private input mount.
    """
    docker = os.environ.get('DOCKER_CLI', 'docker')
    image = os.environ.get('REGRESSION_RUNNER_IMAGE', 'magicstick-regression:local')
    environment = {**os.environ, 'REGRESSION_INPUT_DIR': str(directory),
                   'REGRESSION_PRIVATE_DIR': str(directory.parent / 'private'),
                   'REGRESSION_RUNNER_IMAGE': image,
                   'REGRESSION_RUNNER_UID': str(os.getuid()), 'REGRESSION_RUNNER_GID': str(os.getgid())}
    try:
        for arguments, message in [(['info'], 'Start Docker/Rancher Desktop before automatic setup.'),
                                   (['image', 'inspect', image], 'Build the updated runner first: bash tools/regression.sh build')]:
            result = subprocess.run([docker, *arguments], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            if result.returncode:
                raise SetupError(message)
        request = {key: seed[key] for key in ['dashboardUrl', 'identityUrl', 'usernameFile', 'passwordFile']}
        request.update(version=1, mode=mode)
        if seed.get('caFile'):
            request['caFile'] = seed['caFile']
        if reviewed:
            request['reviewed'] = reviewed
            request['approveAdminGrant'] = approve_admin
            if mode in ['license-fixtures', 'verify-fixtures']:
                request['approveTestSigner'] = approve_admin
            if mode == 'stop-models':
                request['approveStopModels'] = approve_admin
            if mode == 'module-fixture':
                request['approveModuleFixture'] = approve_admin
            if mode == 'recover-actions':
                request['approveRecovery'] = approve_admin
        private_write(directory / '.setup-api-request.json', request)
        result_path = directory / '.setup-api-result.json'
        if result_path.exists():
            private_read(result_path)
            result_path.unlink()
        command = [docker, 'compose', '-f', str(EXAMPLES / 'compose.yaml')]
        override = os.environ.get('REGRESSION_COMPOSE_OVERRIDE')
        if override or (directory / 'compose.override.yaml').exists():
            command.extend(['-f', override or str(directory / 'compose.override.yaml')])
        # Worker only emits fixed messages. Do not forward Docker/plugin errors:
        # users receive a deterministic setup reason, not arbitrary private data.
        result = subprocess.run([*command, 'run', '--rm', '--no-deps', '-T', 'setup-api'], env=environment,
                                capture_output=True, text=True, timeout=900 if mode in ['stop-models', 'register', 'refresh'] else 240)
        if result.returncode:
            if (directory / '.setup-access-restore.json').exists():
                raise SetupError('Kubernetes access restoration needs review. Run: bash tools/regression.sh setup --restore-kubernetes-access')
            reasons = {'TLS': 'Verified HTTPS/DNS connectivity failed before authorization.',
                       'AUTH': 'The admin login or Kubernetes OIDC identity could not be verified.',
                       'PREREQUISITE': 'The configured Kubernetes Access integration or required approved setup permission is unavailable.',
                       'IDENTITY': 'The account, endpoints or Appliance UID changed after discovery; setup refused the new target.',
                       'API': 'An authenticated Dashboard/API contract is unavailable; check API Access and Kubernetes Access.',
                       'CONFIG': 'Rebuild the updated runner and check the saved setup inputs.',
                       'PRIVATE_FILE': 'A private setup input is missing, unsafe or unreadable.',
                       'CONFLICT': 'An intervening access change requires private owner review.',
                       'LAB': 'The registered Appliance/Node identity or immutable test-server marker could not be verified.',
                       'LOCK_BUSY': 'Another test run still owns the registered lab lease.',
                       'LOCK_STALE': 'An expired test lease remains from an interrupted run. Inspect its exact journal and recover owned resources before releasing it.',
                       'RECOVERY': 'Automatic recovery cannot prove the previous baseline. Keep the same private run directory and inspect its recovery receipt.',
                       'OWNERSHIP': 'An interrupted test resource has no verified UID or was replaced. Automatic cleanup refused to adopt it.',
                       'CLEANUP': 'Automatic cleanup could not verify restoration; its recovery receipt is retained for the next attempt.',
                       'LOCK_LOST': 'The recovery lease was lost. No further cleanup writes were allowed.',
                       'DEADLINE': 'The setup stage timed out before its result could be verified.',
                       'UNEXPECTED': 'The setup worker failed unexpectedly; check the runner bootstrap stage.'}
            # Compose may multiplex container stderr into its stdout stream.
            # Extract fixed codes from both, never forward raw diagnostics.
            worker_output = (getattr(result, 'stderr', '') or '') + '\n' + (getattr(result, 'stdout', '') or '')
            known = re.findall(r'^\[(' + '|'.join(reasons) + r')\]', worker_output, re.M)
            explanation = reasons[known[-1]] if known else 'Verified Dashboard/API setup failed; check the updated runner image and reachable endpoints.'
            stages = {'request': 'reading the private setup request', 'tls': 'verifying HTTPS', 'login': 'signing in',
                      'discovery': 'discovering Dashboard/API contracts', 'kubernetes-access': 'obtaining Kubernetes access',
                      'oidc-session': 'authorizing the Kubernetes OIDC session', 'bootstrap-file': 'writing the temporary bootstrap access',
                      'lab-bootstrap': 'provisioning registered lab access', 'run-recovery': 'recovering the exact interrupted regression run', 'license-fixtures': 'preparing test licenses',
                      'license-validation': 'verifying test-license trust'}
            details = {'ENOENT': 'A required runner file is missing.', 'EACCES': 'A required private file is not accessible.',
                       'ENOSPC': 'The runner has no free storage.', 'TYPE_ERROR': 'The setup worker encountered an invalid value.',
                       'SYNTAX_ERROR': 'The setup worker could not parse a required document.',
                       'ERR_FAILED': 'The browser navigation failed.', 'ERR_BLOCKED_BY_CLIENT': 'The browser request guard rejected the navigation.',
                       'ERR_CONNECTION_REFUSED': 'The browser endpoint refused the connection.', 'ERR_NAME_NOT_RESOLVED': 'The browser endpoint did not resolve.',
                       'ERR_CERT_AUTHORITY_INVALID': 'The browser did not trust the endpoint certificate.',
                       'ERR_HTTP2_PROTOCOL_ERROR': 'The browser endpoint returned an HTTP/2 protocol error.'}
            stage = re.findall(r'^\[SETUP_STAGE:([a-z-]+)\](?: \[detail:(' + '|'.join(details) + r')\])?$', worker_output, re.M)
            if stage and stage[-1][0] in stages:
                explanation += ' Setup failed while ' + stages[stage[-1][0]] + '.'
                if stage[-1][1]:
                    explanation += ' ' + details[stage[-1][1]]
            outcome = 'Failed' if result.returncode == 1 or '[outcome:Failed]' in worker_output or \
                known and known[-1] in ['API', 'AUTH', 'CONFIG', 'CONFLICT'] else 'Blocked'
            raise SetupError(explanation + ' No TLS bypass, accepted repinning or retained admin fallback was used.', outcome,
                             code=known[-1] if known else 'PREREQUISITE',
                             stage=stage[-1][0] if stage and stage[-1][0] in stages else None,
                             detail=stage[-1][1] if stage and stage[-1][0] in stages and stage[-1][1] else None)
        value = json.loads(private_read(result_path))
        if mode == 'restore':
            if value != {'version': 1, 'restored': True}:
                raise SetupError('Access restoration did not return its required confirmation.')
        else:
            for field in ['dashboardUrl', 'identityUrl', 'inferenceUrl', 'kubernetesApiUrl']:
                value[field] = origin(value[field])
            if value.get('version') != 1 or value['dashboardUrl'] != seed['dashboardUrl'] or value['identityUrl'] != seed['identityUrl'] or \
                    not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', value.get('subject', '')) or \
                    not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', value.get('applianceUid', '')) or \
                    value.get('accessLevel') not in ['none', 'viewer', 'operator', 'admin']:
                raise SetupError('Authenticated setup discovery did not return an unambiguous target.')
        return value
    except (OSError, subprocess.SubprocessError):
        raise SetupError('Automatic setup needs the updated local Docker runner and reachable verified endpoints. No image was built or pulled.') from None
    finally:
        for name in ['.setup-api-request.json', '.setup-api-result.json']:
            path = directory / name
            if path.exists() and not path.is_symlink():
                path.unlink()


def provision_test_license_trust(kubeconfig, directory, fixture, expected_uid):
    """Explicit disposable-lab trust, preserving every official/local key.

    Only the public key is sent to Kubernetes; the test signer remains private.
    A pending marker records ambiguous writes and blocks ordinary test launches.
    """
    if not re.fullmatch(r'regression-[a-f0-9-]{36}', fixture.get('kid', '')) or \
            'PRIVATE KEY' in fixture.get('publicKey', ''):
        raise SetupError('Only a generated regression test signer can be provisioned.')
    match = re.fullmatch(r'-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*', fixture.get('publicKey', ''))
    if not match or hashlib.sha256(base64.b64decode(match.group(1), validate=False)).hexdigest() != fixture.get('fingerprint'):
        raise SetupError('The generated test public-key fingerprint could not be verified.')
    appliances = json.loads(kubectl(kubeconfig, ['get', 'appliances.appliance.magicstick.dev', '-A', '-o', 'json']))['items']
    if len(appliances) != 1 or appliances[0]['metadata']['uid'] != expected_uid:
        raise SetupError('Test-license trust refused a replaced or different appliance.')
    value = json.loads(kubectl(kubeconfig, ['get', 'configmap', 'magicstick-license-trust', '-n', 'identity-system', '-o', 'json']))
    old = value['data']['trusted-keys.json']
    trust = json.loads(old)
    if set(trust) != {'keys'} or not isinstance(trust['keys'], dict):
        raise SetupError('The optional local trust store needs owner review; it was not replaced.')
    kid, public = fixture['kid'], fixture['publicKey']
    pending = directory / '.setup-license-trust-pending.json'
    if pending.exists():
        previous = json.loads(private_read(pending))
        if any(previous.get(key) != value for key, value in [('applianceUid', expected_uid),
                ('storeUid', value['metadata']['uid']), ('kid', kid), ('fingerprint', fixture['fingerprint'])]) or trust['keys'].get(kid) != public:
            raise SetupError('An interrupted test-trust addition is unresolved; review its exact private receipt. Nothing was replayed.')
        pending.unlink()  # Independent read confirms the sole prior public-key addition.
    if kid in trust['keys'] and trust['keys'][kid] != public:
        raise SetupError('A different key already uses this regression signer ID; refusing replacement.')
    receipt = {'version': 1, 'applianceUid': expected_uid, 'storeUid': value['metadata']['uid'],
               'kid': kid, 'fingerprint': fixture['fingerprint'], 'state': 'provisioned'}
    if kid not in trust['keys']:
        print('WARNING: Adding a disposable signer to OPTIONAL LOCAL license trust on this test installation only.')
        print('Official verification keys remain unchanged. Test licenses must never be used for customer/production licensing.')
        print('Test signer public-key SHA-256: ' + fixture['fingerprint'])
        if input('Type the Appliance UID to approve this local test-trust addition: ').strip() != expected_uid:
            raise SetupError('Local test-license trust was not approved.')
        updated = {'keys': {**trust['keys'], kid: public}}
        private_write(directory / '.setup-license-trust-pending.json', {**receipt, 'state': 'requested'})
        patch = [{'op': 'test', 'path': '/metadata/uid', 'value': value['metadata']['uid']},
                 {'op': 'test', 'path': '/metadata/resourceVersion', 'value': value['metadata']['resourceVersion']},
                 {'op': 'test', 'path': '/data/trusted-keys.json', 'value': old},
                 {'op': 'replace', 'path': '/data/trusted-keys.json', 'value': json.dumps(updated)}]
        result = json.loads(kubectl(kubeconfig, ['patch', 'configmap', 'magicstick-license-trust', '-n', 'identity-system', '--type=json', '-p', json.dumps(patch)]))
        if result['metadata']['uid'] != value['metadata']['uid'] or json.loads(result['data']['trusted-keys.json']) != updated:
            raise SetupError('Test-trust write is ambiguous. Review the private pending receipt before further tests.')
        (directory / '.setup-license-trust-pending.json').unlink()
    private_write(directory / 'test-license-trust.json', receipt)


def yes_no(label, default=False):
    """Explicit interactive consent, never supplied by an environment flag."""
    while True:
        answer = input(label + (' [Y/n]: ' if default else ' [y/N]: ')).strip().lower()
        if not answer:
            return default
        if answer in ['y', 'yes']:
            return True
        if answer in ['n', 'no']:
            return False
        print('Please answer y or n.')


def question(label, default='', optional=False, check=None):
    while True:
        answer = input(label + (' [keep saved/default]' if default != '' else '') + (' (SKIP skips)' if optional and default != '' else ' (blank skips)' if optional else '') + ': ').strip()
        if optional and answer.lower() in ['skip', '-']:
            return None
        value = answer or str(default)
        if not value and optional:
            return None
        if value and len(value) < 256 and '\x00' not in value and not re.search(r'[\r\n]', value) and 'CHANGEME' not in value:
            try:
                if check:
                    return check(value)
                return value
            except (ValueError, SetupError):
                pass
        print('Enter a valid value, or explicitly skip this section. No file needs to be hand-written.')


def integer_question(label, default, minimum, maximum):
    def checked(value):
        number = int(value)
        if not minimum <= number <= maximum:
            raise ValueError()
        return number
    return question(label + ' (' + str(minimum) + '-' + str(maximum) + ')', default, check=checked)


def selected_phases(value):
    if not re.fullmatch(r'[0-8](?:-[0-8])?(?:,[0-8](?:-[0-8])?)*', value):
        raise ValueError()
    phases = set()
    for part in value.split(','):
        bounds = list(map(int, part.split('-')))
        first, last = bounds[0], bounds[-1]
        if first > last:
            raise ValueError()
        phases.update(range(first, last + 1))
    return sorted(phases)


def suite_consent(facts, previous=None):
    """All scopes are installation-bound and reviewable; no blanket '--yes'."""
    inventory = facts['inventory']
    nodes = sorted(item['nodeUid'] for item in inventory['nodes'])
    if not nodes or len(set(nodes)) != len(nodes):
        raise SetupError('The complete setup requires unambiguous managed Node identities.')
    previous = previous or {}
    matching = previous.get('applianceUid') == facts['applianceUid'] and sorted(previous.get('nodeUids', [])) == nodes
    phases = question('Test phases', ','.join(map(str, previous.get('phases', []))) if matching else '0-8', check=selected_phases)
    print('WARNING: Complete regression setup is for a disposable TEST installation, not production.')
    print('Tests may create/delete test resources, interrupt models, replace licenses and restart/reconfigure this host.')
    print('Intended test Appliance UID: ' + facts['applianceUid'])
    if input('Type that UID to bind setup and future approvals to THIS test installation: ').strip() != facts['applianceUid']:
        raise SetupError('Test-installation confirmation was not provided. No suite consent was stored.')
    descriptions = [
        ('gpu', [3, 4, 6, 7, 8], 'Temporarily switch AMD DRA/NVIDIA time-slicing, restarting model runtimes; restore sharing afterwards'),
        ('identity', [5, 8], 'Create/change/remove disposable regression users, never recovery or existing accounts'),
        ('kubernetes', [5], 'Temporarily grant Kubernetes rights ONLY to disposable regression users'),
        ('modules', [5], 'Enable/disable the explicitly selected non-critical optional module'),
        ('amd-profile', [5], 'Temporarily change the advertised AMD runtime profile and restore it'),
        ('license', [5], 'Temporarily replace the license and reset/restore its document-only no-file baseline; installation identity and issuer trust remain unchanged'),
        ('api-restart', [5], 'Restart ONLY the Dashboard API Pod for license persistence tests'),
        ('first-license', [5], 'If no license exists, retain the first test-license activation (no delete API)'),
        ('federation', [5], 'Create/remove disposable OIDC/SAML providers and their test identities'),
        ('mesh', [7], 'Create/join/leave a disposable Mesh on TWO separately selected test appliances'),
        ('realtime', [7], 'Temporarily switch sharing and start advertised Omni Realtime models'),
        ('unmanaged-key', [5, 8], 'Create a one-hour disposable unmanaged LiteLLM key for the denied-delete probe, then remove ONLY that fixture; master key stays in memory'),
        ('cache', [8], 'Clear the selected test FreeToken model cache; downloads will be needed again'),
        ('host-drills', [6], 'DESTRUCTIVE host drills: reboots, GPU memory, network rollback, updates, channel changes and model-cache deletion'),
    ]
    scopes = []
    old_scopes = previous.get('scopes', []) if matching else []
    reuse = matching and yes_no('Reuse previously reviewed per-scope answers for this unchanged installation?', True)
    for scope, required, warning in descriptions:
        if not set(required).intersection(phases):
            continue
        # Even a saved refusal remains a refusal. Newly selected scopes require a new question.
        if reuse and scope in previous.get('reviewedScopes', []):
            approved = scope in old_scopes
            print('Saved scope ' + scope + ': ' + ('approved' if approved else 'not approved'))
        else:
            print('WARNING [' + scope + ']: ' + warning + '.')
            approved = yes_no('Approve this exact future test scope?', scope in old_scopes)
        if approved:
            scopes.append(scope)
    return {'version': 1, 'testLab': True, 'applianceUid': facts['applianceUid'], 'nodeUids': nodes,
            'phases': phases, 'scopes': scopes, 'reviewedScopes': [scope for scope, required, _ in descriptions if set(required).intersection(phases)],
            'confirmedAt': datetime.now(timezone.utc).isoformat()}


def reusable_secret(directory, filename, label):
    path = directory / filename
    if path.exists() and yes_no('Reuse the saved ' + label + '?', True):
        private_read(path)
    else:
        value = hidden_password(label)
        if not value or '\x00' in value or '\n' in value or '\r' in value or len(value) > 32768:
            raise SetupError('A secret cannot be empty, contain line breaks or exceed 32 KiB.')
        private_write(path, value + '\n')
    return '/inputs/' + filename


def download_oidc_plugin(directory, architecture, automatic=False):
    """Pinned int128/kubelogin upstream assets, verified before unpacking.
    Release/checksums: github.com/int128/kubelogin/releases/tag/v1.36.4.
    Read one named archive member only, never extract paths or execute on Mac.
    """
    digests = {'amd64': '9e8baeb4905d35a301304af2548324997add512fe94ab20e65993d167212bf85',
               'arm64': '669c2d3bcc6766351ad5a7b03971792b4e7a55117b335a12d9858d43a525d9dc'}
    if architecture not in digests:
        raise SetupError('No reviewed Linux OIDC plugin asset for this runner architecture.')
    print('Pinned upstream: int128/kubelogin v1.36.4, Linux ' + architecture + '; archive SHA-256: ' + digests[architecture])
    if not automatic and not yes_no('Download this reviewed upstream asset over verified HTTPS?', False):
        raise SetupError('Plugin download was not approved. A selected local Linux binary can be imported instead.')
    class UpstreamRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            parsed = urlsplit(newurl)
            if parsed.scheme != 'https' or parsed.hostname not in ['github.com', 'release-assets.githubusercontent.com'] or parsed.username or parsed.password:
                raise SetupError('The plugin asset redirected outside the reviewed HTTPS release hosts.')
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    url = 'https://github.com/int128/kubelogin/releases/download/v1.36.4/kubelogin_linux_' + architecture + '.zip'
    opener = build_opener(UpstreamRedirect(), HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(Request(url, headers={'User-Agent': 'MagicStick-regression-setup'}), timeout=45) as response:
        archive = response.read(20 * 1024 * 1024 + 1)
    if len(archive) > 20 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != digests[architecture]:
        raise SetupError('The pinned plugin archive checksum does not match upstream; it was not extracted.')
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        candidates = [item for item in bundle.infolist() if item.filename == 'kubelogin' and not item.is_dir()]
        if len(candidates) != 1 or candidates[0].file_size >= 64 * 1024 * 1024 or stat.S_ISLNK(candidates[0].external_attr >> 16):
            raise SetupError('The upstream plugin archive does not contain one bounded regular kubelogin executable.')
        binary = bundle.read(candidates[0])
    if binary[:6] != b'\x7fELF\x02\x01' or int.from_bytes(binary[18:20], 'little') != (183 if architecture == 'arm64' else 62):
        raise SetupError('The downloaded plugin does not match the Linux runner architecture.')
    target = directory / '.oidc-downloaded'
    if target.is_symlink():
        raise SetupError('Refusing an unsafe plugin download destination.')
    fd, temporary = tempfile.mkstemp(prefix='.plugin-download-', dir=str(directory))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(binary)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o700)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return target


def import_peer_inputs(source, destination):
    if not source.exists() or source.is_symlink() or not source.is_dir() or stat.S_IMODE(source.stat().st_mode) & 0o077:
        raise SetupError('Select an existing private peer input directory; setup never creates a missing peer as evidence.')
    value = json.loads(private_read(source / 'lab.json'))
    if value.get('version') != 1 or not value.get('expected', {}).get('applianceUid'):
        raise SetupError('The peer needs its own accepted lab profile, not a copy of this installation.')
    target = destination / 'peer'
    private_directory(target)
    for field in ['usernameFile', 'passwordFile', 'observerKubeconfig', 'modelCleanupKubeconfig']:
        selected = saved_input_path(source, value[field])
        if selected.parent != source:
            raise SetupError('Peer credential references must remain in the selected private input directory.')
        filename = {'usernameFile': 'username.txt', 'passwordFile': 'password.txt', 'observerKubeconfig': 'observer.yaml', 'modelCleanupKubeconfig': 'model-cleaner.yaml'}[field]
        if field.endswith('Kubeconfig'):
            role_credential(private_read(selected))
        import_file(selected, target / filename)
        value[field] = '/inputs/peer/' + filename
    selected = saved_input_path(source, value['lock']['kubeconfig'])
    if selected.parent != source:
        raise SetupError('The peer Lease credential must stay in its private input directory.')
    role_credential(private_read(selected))
    import_file(selected, target / 'locker.yaml')
    value['lock']['kubeconfig'] = '/inputs/peer/locker.yaml'
    if value.get('caFile'):
        selected = saved_input_path(source, value['caFile'])
        if selected.parent != source:
            raise SetupError('The peer public CA must stay in its selected input directory.')
        current = private_read(destination / 'appliance-ca.pem') if (destination / 'appliance-ca.pem').exists() else ''
        peer_ca = private_read(selected)
        certificates = list(dict.fromkeys(re.findall(r'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----', current + '\n' + peer_ca)))
        trust_ca('\n'.join(certificates) + '\n', destination / 'appliance-ca.pem')
    value['caFile'] = '/inputs/appliance-ca.pem' if (destination / 'appliance-ca.pem').exists() else None
    if value['caFile'] is None:
        value.pop('caFile')
    private_write(target / 'lab.json', value)
    return value


def host_drill_questions(directory, facts, consent):
    """Save typed recipes and expected results, NOT stale future-boot plans.
    Runtime rebinds each recipe only to a fresh report from the same physical
    installation, with normal product validation and exact outcome checks.
    """
    previous_file = directory / 'host-drills.json'
    old = json.loads(private_read(previous_file)) if previous_file.exists() else {}
    # A refusal or interrupted new review must revoke previously saved consent.
    if old:
        revoked = {**old, 'approveDestructive': False, 'independentRecoveryAvailable': False}
        private_write(previous_file, revoked)
    hosts = facts['inventory']['hosts']
    selected = question('Host for destructive drills', hosts[0]['name'] if len(hosts) == 1 else '', optional=True)
    host = next((item for item in hosts if item['name'] == selected), None)
    if host is None:
        print('Physical drills remain incomplete until an advertised managed host is selected.')
        return
    if not yes_no('Independent console/recovery access is available throughout EVERY destructive drill?', False):
        print('Destructive drills are not approved without independent recovery access.')
        return
    print('NET-07 needs a console restart during its unconfirmed network trial; it cannot be faked by a browser/API call.')
    if old.get('version') == 2 and old.get('applianceUid') == facts['applianceUid'] and old.get('nodeUid') == host['nodeUid'] and \
            yes_no('Reuse all previously reviewed typed destructive-test recipes for this same host?', True):
        private_write(previous_file, {**old, 'approveDestructive': True, 'independentRecoveryAvailable': True})
        return
    cases = {}
    groups = [('prepare-gpu', ['HOST-04', 'HOST-05']), ('configure-gpu-memory', ['GPUHOST-05', 'GPUHOST-06', 'GPUHOST-07']),
              ('configure-network', ['NET-05', 'NET-06', 'NET-07']), ('install-updates', ['UPD-05']), ('configure-updates', ['UPD-07']),
              ('apply-software-channel', ['CHANNEL-06', 'CHANNEL-07', 'CHANNEL-08']), ('clear-model-cache', ['CACHE-04', 'CACHE-06']),
              ('reboot', ['BOOT-02', 'BOOT-03', 'BOOT-04'])]
    for action, identifiers in groups:
        print('WARNING: ' + action + ' drills [' + ', '.join(identifiers) + ']. These can interrupt the host; cache removal and package updates cannot be undone automatically.')
        if not yes_no('Configure this destructive test group now?', False):
            continue
        for identifier in identifiers:
            recipe = {'action': action, 'allowExperimental': False, 'experimentMode': False}
            expected = {'bootChanges': 1 if action == 'reboot' else 0, 'kernel': host['kernel'], 'terminal': 'Succeeded'}
            if action == 'prepare-gpu':
                if not host.get('plan'):
                    print(identifier + ': this host has no advertised preparation plan; no plan was invented.')
                    continue
                recipe['allowExperimental'] = yes_no(identifier + ': permit the advertised experimental hardware plan?', False)
                recipe['experimentMode'] = yes_no(identifier + ': permit the advertised mixed-hardware experiment plan?', False)
                expected['kernel'] = question(identifier + ': expected running kernel after preparation', host['plan']['targetKernel'])
                expected['bootChanges'] = integer_question(identifier + ': expected new boots', int(host['plan']['rebootRequired']), 0, 2)
            elif action == 'configure-gpu-memory':
                memory = host.get('gpuMemory') or {}
                if not memory.get('supported') or not memory.get('options'):
                    print(identifier + ': no supported firmware memory controls on this host.')
                    continue
                print('Advertised firmware choices: ' + ', '.join(str(item['index']) + '=' + item['label'] for item in memory['options']))
                current_index = memory.get('currentCarveoutIndex', 0)
                if identifier == 'GPUHOST-05':
                    index = current_index
                    print('GPUHOST-05 retains the current fixed reservation; only the dynamic limit changes.')
                else:
                    different = next((item['index'] for item in memory['options'] if item['index'] != current_index), current_index)
                    index = integer_question(identifier + ': firmware choice index', different if identifier == 'GPUHOST-06' else current_index, 0, max(item['index'] for item in memory['options']))
                option = next((item for item in memory['options'] if item['index'] == index), None)
                if not option:
                    raise SetupError('Select an actual firmware choice from this host.')
                maximum = int(memory['systemMemoryMi'] + memory.get('currentCarveoutMi', 0) - option['sizeMi'] - memory.get('systemReserveMi', 16384))
                step = int(memory.get('stepMi') or 1024)
                minimum = int(memory.get('minDynamicLimitMi') or 1024)
                maximum = maximum // step * step
                if maximum < minimum:
                    raise SetupError('This firmware choice leaves no valid dynamic memory budget; select a smaller reservation.')
                current_dynamic = int(memory['currentDynamicLimitMi'])
                default_dynamic = min(maximum, max(minimum, current_dynamic - step))
                dynamic = integer_question(identifier + ': requested dynamic GPU memory MiB (step ' + str(step) + ')', default_dynamic, minimum, maximum)
                if dynamic % step or index == current_index and dynamic == current_dynamic or identifier == 'GPUHOST-06' and index == current_index:
                    raise SetupError('The memory drill needs a real applicable change in the advertised step size; GPUHOST-06 must change the fixed reservation.')
                recipe['gpuMemory'] = {'carveoutIndex': index, 'dynamicLimitMi': dynamic}
                expected.update(bootChanges=integer_question(identifier + ': expected new boots', 1, 1, 2), dynamicLimitMi=dynamic, carveoutMi=option['sizeMi'])
            elif action == 'configure-network':
                network = host.get('network') or {}
                interfaces = [item for item in network.get('interfaces', []) if item['editable']]
                print('Editable interfaces: ' + ', '.join(item['name'] for item in interfaces))
                name = question(identifier + ': interface', interfaces[0]['name'] if len(interfaces) == 1 else '', optional=True)
                interface = next((item for item in interfaces if item['name'] == name), None)
                if interface is None:
                    continue
                mode = question(identifier + ': IPv4 mode (dhcp/static)', interface.get('configuredMode', 'dhcp'))
                if mode not in ['dhcp', 'static']:
                    raise SetupError('Only advertised DHCP/static IPv4 settings are accepted.')
                # Use distinct real changes for success/rollback/reboot trials,
                # not a no-op that the product correctly disables.
                base_metric = interface.get('metric') if interface.get('metric') is not None else 100
                trial_metric = (base_metric + identifiers.index(identifier) + 1) % 65536
                settings = {'interface': name, 'mode': mode, 'metric': integer_question(identifier + ': route metric', trial_metric, 0, 65535)}
                if mode == 'static':
                    settings['address'] = question(identifier + ': static IPv4/prefix', interface.get('configuredAddress', ''), check=lambda value: str(ipaddress.IPv4Interface(value)))
                    gateway = question(identifier + ': IPv4 gateway', interface.get('configuredGateway', ''), optional=True, check=lambda value: str(ipaddress.IPv4Address(value)))
                    if gateway:
                        settings['gateway'] = gateway
                if interface['kind'] == 'wifi':
                    settings.update(ssid=question(identifier + ': existing reviewed SSID', interface.get('configuredSsid', '')), security=interface.get('security', 'wpa-psk'))
                    print('Saved Wi-Fi credentials are retained for the same SSID. Passwords are never placed in drill recipes.')
                ipv4 = [item for item in interface.get('addresses', []) if ':' not in item]
                addresses = question(identifier + ': expected IPv4 addresses after success/rollback (comma-separated)', ','.join(ipv4),
                                     check=lambda value: [str(ipaddress.IPv4Interface(item.strip())) for item in value.split(',')])
                recipe['network'] = settings
                expected.update(ipv4=addresses, terminal='Succeeded' if identifier == 'NET-05' else 'RolledBack', bootChanges=1 if identifier == 'NET-07' else 0)
            elif action == 'install-updates':
                recipe['updateScope'] = question(identifier + ': Ubuntu update scope (security/all)', 'security')
                if recipe['updateScope'] not in ['security', 'all']:
                    raise SetupError('Only signed current-release security/all Ubuntu updates are available.')
            elif action == 'configure-updates':
                policy = (host.get('updates') or {}).get('policy', {})
                recipe['updatePolicy'] = {'mode': 'security', 'windowStart': question(identifier + ': UTC daily start HH:MM', policy.get('windowStart', '03:00')),
                    'windowMinutes': integer_question(identifier + ': window minutes', policy.get('windowMinutes', 120), 15, 360), 'automaticReboot': True}
                print('UPD-07 requires a real pending allowed update that schedules a restart in this UTC window; no synthetic success.')
                expected['bootChanges'] = 1
            elif action == 'apply-software-channel':
                software = host.get('software') or {}
                kind = question(identifier + ': target kind (branch/tag/commit)', 'branch')
                if kind not in ['branch', 'tag', 'commit']:
                    raise SetupError('Choose branch, tag or commit, not a command or repository.')
                recipe['softwareChannel'] = {'kind': kind, 'value': question(identifier + ': exact target value', (software.get('channel') or {}).get('value', 'develop'))}
                if identifier == 'CHANNEL-07':
                    print('Select a controlled target with a READY preview which is expected to fail during application, not a nonexistent ref. This is a fault fixture, not a normal branch.')
                    expected['terminal'] = question(identifier + ': expected failure phase (Failed/Interrupted)', 'Failed')
                else:
                    expected['sourceCommit'] = question(identifier + ': expected full installed commit', software.get('hostCommit', ''), check=lambda value: value if re.fullmatch(r'[0-9a-f]{40}', value) else (_ for _ in ()).throw(ValueError()))
                    print('Successful channel transitions also require exact web/API image digests, never tags or guessed hashes.')
                    expected['images'] = []
                    for namespace, deployment, container in [('dashboard', 'ai-appliance-dashboard', 'web'), ('identity-system', 'ai-appliance-dashboard-api', 'api')]:
                        digest = question(identifier + ': ' + container + ' expected sha256 image digest', check=lambda value: value if re.fullmatch(r'sha256:[a-f0-9]{64}', value) else (_ for _ in ()).throw(ValueError()))
                        expected['images'].append({'namespace': namespace, 'deployment': deployment, 'container': container, 'digest': digest})
            elif action == 'clear-model-cache':
                print(identifier + ': the product clears ALL clearable Hugging Face/Ollama model caches, not container images or user data.')
                if not yes_no('Approve removal of these two model caches for this exact test?', False):
                    continue
                expected['freeCacheIds'] = ['huggingface', 'ollama']
            cases[identifier] = {'recipe': recipe, 'expected': expected}
    private_write(directory / 'host-drills.json', {'version': 2, 'applianceUid': facts['applianceUid'], 'nodeUid': host['nodeUid'],
        'nodeName': host['name'], 'approveDestructive': True, 'independentRecoveryAvailable': True, 'cases': cases})


def run_preparation(directory, arguments):
    docker = os.environ.get('DOCKER_CLI', 'docker')
    environment = {**os.environ, 'REGRESSION_INPUT_DIR': str(directory), 'REGRESSION_PRIVATE_DIR': str(directory.parent / 'private'),
                   'REGRESSION_RUNNER_UID': str(os.getuid()), 'REGRESSION_RUNNER_GID': str(os.getgid())}
    command = [docker, 'compose', '-f', str(EXAMPLES / 'compose.yaml')]
    if (directory / 'compose.override.yaml').exists():
        command += ['-f', str(directory / 'compose.override.yaml')]
    # Preparation's public messages are static/allowlisted. No raw subprocess stderr is forwarded.
    result = subprocess.run([*command, 'run', '--rm', '--no-deps', '-T', 'prepare', *arguments], env=environment,
                            capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise SetupError('Verified input preparation failed. Check trusted connectivity, current telemetry and private pending receipts; accepted inputs were not bypassed.',
                         'Failed' if result.returncode == 1 else 'Blocked')


def finish_complete_setup(directory, seed):
    print('Final setup check: discovering current pins, small catalog fixtures, telemetry and CI evidence.')
    phases = seed['suiteConsent']['phases']
    run_preparation(directory, ['--phases', ','.join(map(str, phases))])
    latest = json.loads(private_read(directory / '.preparation-latest.json'))
    identifier = latest.get('id', '')
    if not re.fullmatch(r'[a-f0-9-]{36}', identifier):
        raise SetupError('Preparation returned no reviewed proposal identifier.')
    proposal = directory / 'prepared' / identifier
    plan = json.loads(private_read(proposal / 'plan.json'))
    print(private_read(proposal / 'readiness.txt'))
    ready = [item['phase'] for item in plan['readiness'] if item['state'] == 'InputsReady']
    incomplete = [item['phase'] for item in plan['readiness'] if item['state'] != 'InputsReady']
    if input('Type ACCEPT to store these freshly checked test pins and scoped answers; blank leaves the proposal only: ').strip() != 'ACCEPT':
        print('No accepted inputs changed. The proposal and all answers are saved privately for later review.')
        return False
    run_preparation(directory, ['--accept', identifier])
    print('Accepted test-ready phase inputs: ' + (', '.join(map(str, ready)) or 'none'))
    if incomplete:
        print('SETUP INCOMPLETE for phases: ' + ', '.join(map(str, incomplete)) + '. The Missing/Action list above states the actual remaining resources; no gate was waived.')
    else:
        print('SETUP READY for all selected phases. This is input readiness, not a passed regression suite.')
    if ready:
        print('Run: bash tools/regression.sh all' + (' --phases ' + ','.join(map(str, ready)) if incomplete else ''))
    else:
        print('No selected phase is test-ready yet. Resolve the printed Missing/Action items and rerun setup.')
    private_write(directory / 'setup-readiness.json', {'version': 1, 'readyPhases': ready, 'blockedPhases': incomplete, 'acceptedProposal': identifier,
                                                     'allSelectedInputsReady': not incomplete, 'testsExecuted': False})
    return not incomplete


def complete_fixtures(directory, seed, facts, consent):
    """One guided form for every suite prerequisite; external resources are
    requested, not fabricated. The operator never has to author fixture JSON.
    """
    profile = json.loads(private_read(directory / 'remaining-p0.json')) if (directory / 'remaining-p0.json').exists() else {'version': 1}
    phases, scopes, inventory = consent['phases'], consent['scopes'], facts['inventory']
    # A new explicit setup replaces old operation answers, including refusals.
    def reset(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.startswith('approve') or key == 'allowFirstActivation':
                    value[key] = False
                else:
                    reset(item)
        elif isinstance(value, list):
            for item in value:
                reset(item)
    reset(profile)
    if 5 in phases:
        print('Application tests need the actual controls shipped by each application; selectors are never guessed.')
        if yes_no('Configure/reuse the five application UI adapters now?', True):
            old = {item['type']: item for item in profile.get('applications', {}).get('fixtures', [])}
            fixtures = []
            for kind in ['openclaw', 'hermes', 'paperclip', 'kubeopencode', 'odysseus']:
                if kind not in inventory['applications']:
                    print('Missing advertised application: ' + kind)
                    continue
                fixture = {'type': kind}
                for field, label in [('originTemplate', 'HTTPS origin containing {name}'), ('promptLabel', 'Accessible prompt label'),
                                     ('sendButton', 'Accessible send button name'), ('responseSelector', 'Response CSS selector')]:
                    default = old.get(kind, {}).get(field, '')
                    if field == 'originTemplate' and not default:
                        default = 'https://{name}.' + kind + '.' + urlsplit(seed['dashboardUrl']).hostname
                    value = question(kind + ': ' + label, default, optional=True)
                    if value is None:
                        break
                    if field == 'originTemplate':
                        if value.count('{name}') != 1:
                            raise SetupError('An app origin needs exactly one {name} placeholder.')
                        origin(value.replace('{name}', 'reg-fixture'))
                    fixture[field] = value
                if len(fixture) == 5:
                    fixture['responseMarker'] = question(kind + ': expected response marker', old.get(kind, {}).get('responseMarker', 'REGRESSION'))
                    fixtures.append(fixture)
            profile['applications'] = {'cleanerKubeconfig': '/inputs/app-cleaner.kubeconfig', 'fixtures': fixtures}
        if 'kubernetes' in scopes:
            plugin = profile.get('kubernetes', {}).get('plugin', {})
            print('The runner needs a Linux kubectl-oidc_login binary, not your Mac executable. Import is checksum-reviewed once.')
            if (directory / 'kubectl-oidc_login').exists() and yes_no('Reuse the saved reviewed Linux OIDC plugin?', True):
                pass
            else:
                answer = question('Linux OIDC plugin path (or D to download the pinned upstream Linux release)', 'D', optional=True)
                if answer:
                    source = download_oidc_plugin(directory, inventory['runnerArchitecture']) if answer.lower() == 'd' else Path(answer).expanduser()
                    sha = oidc_plugin(source, directory / 'kubectl-oidc_login')
                    plugin = {'filename': '/inputs/kubectl-oidc_login', 'sha256': sha}
            profile['kubernetes'] = {'approveAdminGrant': False, 'plugin': plugin}
        if 'modules' in scopes:
            choices = [item['id'] for item in inventory['optionalModules'] if item['disabled']]
            print('Advertised non-critical disabled modules: ' + (', '.join(choices) or 'none'))
            identifier = question('Optional module fixture ID', profile.get('modules', {}).get('id', choices[0] if len(choices) == 1 else ''), optional=True)
            if identifier:
                if identifier not in choices:
                    raise SetupError('Select an actually advertised disabled non-critical module.')
                selected = next(item for item in inventory['optionalModules'] if item['id'] == identifier)
                parameters = dict(selected.get('parameters') or {})
                print('Existing module parameters are retained. Setup can prepare a disabled intent without starting this module.')
                profile['modules'] = {'approveOptionalModule': False, 'id': identifier, 'parameters': parameters}
        if 'amd-profile' in scopes:
            choices = inventory['amdProfiles']
            print('Advertised alternate AMD profiles: ' + (', '.join(item['id'] for item in choices) or 'none'))
            identifier = question('Alternate AMD profile ID', profile.get('moduleProfile', {}).get('profileId', choices[0]['id'] if len(choices) == 1 else ''), optional=True)
            if identifier:
                selected = next((item for item in choices if item['id'] == identifier), None)
                if not selected:
                    raise SetupError('An alternate profile must be advertised by this installation.')
                allow = not selected['experimental'] or yes_no('WARNING: permit the selected experimental AMD runtime profile?', False)
                profile['moduleProfile'] = {'approveTemporaryProfile': False, 'profileId': identifier, 'allowExperimental': bool(selected['experimental'] and allow)}
        if 'license' in scopes:
            profile['license'] = {'approveLicenseReplacement': False, 'allowFirstActivation': False,
                'validFile': '/inputs/license-valid.license', 'invalidFiles': ['/inputs/license-' + kind + '.license' for kind in ['expired', 'wrong-installation', 'tampered']],
                'baseline': {'approveNoFileBaseline': False, 'kubeconfig': '/inputs/license-resetter.kubeconfig'},
                'restart': {'approveApiRestart': False, 'kubeconfig': '/inputs/api-restarter.kubeconfig'}}
        if 'federation' in scopes:
            if yes_no('Configure/reuse a controlled external TEST IdP for OIDC/SAML now?', True):
                old = profile.get('federation', {})
                upstream = old.get('upstream', {})
                upstream_origin = question('Controlled test IdP HTTPS origin', upstream.get('origin', ''), optional=True, check=origin)
                if upstream_origin:
                    if upstream_origin == seed['identityUrl']:
                        raise SetupError('The federation test requires a separate controlled IdP, not this installation\'s Identity origin.')
                    seed.setdefault('extraOrigins', []).append(upstream_origin)
                    realm = question('Test IdP realm', upstream.get('realm', 'regression'))
                    client = question('Test IdP user-fixture client ID', upstream.get('clientId', 'regression-users'))
                    secret = reusable_secret(directory, 'idp-users.secret', 'test IdP user-fixture client secret')
                    cleaner = old.get('brokerCleaner', {})
                    cleaner_id = question('Local narrow broker-user cleaner client ID', cleaner.get('clientId', 'regression-broker-cleaner'))
                    cleaner_secret = reusable_secret(directory, 'broker-cleaner.secret', 'local broker-user cleaner client secret')
                    fixtures = []
                    for protocol, suffix in [('oidc', '.well-known/openid-configuration'), ('saml', 'protocol/saml/descriptor')]:
                        saved = next((item for item in old.get('fixtures', []) if item['protocol'] == protocol), {})
                        metadata = question(protocol.upper() + ' metadata URL', saved.get('metadataUrl', upstream_origin + '/realms/' + realm + '/' + suffix))
                        parsed = urlsplit(metadata)
                        if origin('https://' + parsed.netloc) != upstream_origin or parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment:
                            raise SetupError('Metadata must belong to the reviewed HTTPS test IdP.')
                        fixture = {'protocol': protocol, 'metadataUrl': metadata, 'claim': question(protocol.upper() + ' role-mapping claim', saved.get('claim', 'regressionAccess'))}
                        if protocol == 'oidc':
                            fixture.update(clientId=question('OIDC broker client ID', saved.get('clientId', 'regression-broker')),
                                           clientSecretFile=reusable_secret(directory, 'idp-broker.secret', 'OIDC broker client secret'))
                        fixtures.append(fixture)
                    profile['federation'] = {'approveDisposableProviders': False, 'upstream': {'origin': upstream_origin, 'realm': realm, 'clientId': client, 'clientSecretFile': secret},
                        'brokerCleaner': {'origin': seed['identityUrl'], 'realm': 'magicstick', 'clientId': cleaner_id, 'clientSecretFile': cleaner_secret},
                        'expiringLicenseFile': '/inputs/license-short-lived.license', 'restoreLicenseFile': '/inputs/license-original.license',
                        'testSignerFile': '/inputs/test-license-signer.json', 'fixtures': fixtures}
    if 7 in phases:
        if 'realtime' in scopes:
            available = inventory['realtime']
            print('Advertised one-GPU Realtime candidates: ' + (', '.join(item['id'] + '@' + item['node'] for item in available) or 'none'))
            if available and yes_no('Generate/reuse exclusive and shared Realtime fixtures from this catalog?', True):
                identifier = question('Realtime profile ID', available[0]['id'])
                selected = next((item for item in available if item['id'] == identifier), None)
                if not selected:
                    raise SetupError('Select an actually advertised one-GPU Realtime profile.')
                context = integer_question('Realtime context length', selected['contextWindow'], 256, min(4096, selected['maxContextWindow']))
                maximum = int(selected['availableSystemMemoryMi'])
                ram = integer_question('Realtime system RAM budget MiB', min(maximum, selected['systemMemoryMi']), 1024, maximum)
                fraction = question('GPU memory fraction (0.1-0.95)', '0.8', check=lambda value: float(value) if 0.1 <= float(value) <= 0.95 else (_ for _ in ()).throw(ValueError()))
                fixture = {'engine': 'VLLM', 'computeTarget': selected['computeTarget'], 'url': 'hf://' + selected['model'], 'memoryRequiredMi': max(1024, int(selected['gpuMemoryMi'] * fraction)),
                    'contextWindow': context, 'maxNumSeqs': 1, 'realtime': {'profile': identifier, 'gpuNode': selected['node'], 'gpuCount': 1, 'systemMemoryMi': ram,
                    'gpuMemoryFraction': fraction, 'thinkerCpuOffloadGiB': 0}}
                profile['realtime'] = {'approveGpuTransitions': False, 'fixtures': [{'mode': mode, 'maxModels': 2, 'fixture': fixture} for mode in ['exclusive', 'shared']]}
        if 'mesh' in scopes:
            if yes_no('Configure/reuse the second real test appliance for Mesh now?', True):
                old = profile.get('mesh', {})
                # A ready peer can be imported without asking the owner to write any JSON or copy each credential manually.
                peer = question('Second appliance prepared private input directory', optional=True)
                if peer:
                    imported = import_peer_inputs(Path(peer).expanduser(), directory)
                    seed.setdefault('extraOrigins', []).extend(imported[field] for field in ['dashboardUrl', 'identityUrl', 'inferenceUrl'] if imported.get(field))
                    enrollment = question('Mesh enrollment HTTPS origin', old.get('enrollmentOrigin', 'https://mesh.' + urlsplit(seed['dashboardUrl']).hostname), check=origin)
                    seed['extraOrigins'].append(enrollment)
                    profile['mesh'] = {'approveTwoAppliances': False, 'approveGpuTransitions': False, 'peerConfig': '/inputs/peer/lab.json', 'enrollmentOrigin': enrollment}
                else:
                    print('Mesh needs a second appliance: run this setup there first (or with a separate REGRESSION_INPUT_DIR). One machine cannot prove remote inference.')
    if 'unmanaged-key' in scopes:
        if yes_no('Automatically create and clean up a real disposable unmanaged key during its test?', True):
            profile['unmanagedKey'] = {'approveDisposableProbe': False, 'createDisposableFixture': True}
        else:
            value = question('Existing disposable unmanaged-key SHA256 ID', profile.get('unmanagedKey', {}).get('id', ''), optional=True)
            if value:
                if not re.fullmatch(r'[a-f0-9]{64}', value):
                    raise SetupError('Use the SHA256 ID of a real reviewed unmanaged key, never raw key material or a made-up ID.')
                profile['unmanagedKey'] = {'approveDisposableProbe': False, 'id': value}
    if 8 in phases:
        previous = profile.get('repeat', {})
        profile['repeat'] = {'cycles': integer_question('Repetition cycles', previous.get('cycles', 3), 3, 10),
            'maximumMemoryGrowthMi': integer_question('Allowed non-cache memory growth MiB', previous.get('maximumMemoryGrowthMi', 1024), 0, 32768),
            'maximumNonCacheDiskGrowthBytes': integer_question('Allowed non-cache disk growth bytes', previous.get('maximumNonCacheDiskGrowthBytes', 268435456), 0, 10737418240)}
    if set(phases).intersection([7, 8]):
        print('CI evidence is discovered automatically for the exact installed commit; setup never marks a red or missing run green.')
        if yes_no('Save/reuse an optional read-only GitHub token for private/rate-limited CI metadata?', False):
            filename = reusable_secret(directory, 'github-readonly.token', 'read-only GitHub Actions metadata token')
            for section in ['securityCi', 'companion']:
                profile.setdefault(section, {})['tokenFile'] = filename
    profile.setdefault('cache', {'approveFreeToken': False})
    private_write(directory / 'remaining-p0.json', profile)
    if 'host-drills' in scopes:
        host_drill_questions(directory, facts, consent)
    return profile


def automatic_wizard(directory, args):
    private_directory(directory)
    if (directory / '.preparation-accepting.json').exists():
        raise SetupError('Review the interrupted private input acceptance before changing setup.')
    restoring = getattr(args, 'restore_kubernetes_access', False)
    grant_file = directory / '.setup-access-restore.json'
    if grant_file.exists() and not restoring:
        raise SetupError('Restore interrupted temporary access first: bash tools/regression.sh setup --restore-kubernetes-access')
    if restoring and not grant_file.exists():
        raise SetupError('There is no interrupted temporary Kubernetes-access grant to restore.')
    previous = {}
    for name in ['lab.json', 'setup.json']:
        if (directory / name).exists():
            previous.update(json.loads(private_read(directory / name)))
    if restoring:
        previous.update(json.loads(private_read(grant_file))['facts'])
    default = previous.get('dashboardUrl', '')
    seed = {'version': 1, 'dashboardUrl': origin(input('Dashboard HTTPS origin' + (' [keep existing]' if default else '') + ': ').strip() or default)}
    for field, filename, label in [('usernameFile', 'username.txt', 'Dashboard username'),
                                    ('passwordFile', 'password.txt', 'Dashboard password')]:
        saved = saved_input_path(directory, previous.get(field, filename))
        if saved.exists() and input('Reuse the saved ' + label.lower() + '? [Y/n]: ').strip().lower() != 'n':
            content = private_read(saved)
        else:
            content = hidden_password(label) if field == 'passwordFile' else input(label + ': ')
        if not content.strip() or '\x00' in content or '\n' in content.rstrip('\n') or '\r' in content:
            raise SetupError('Credentials cannot be empty or contain line breaks.')
        private_write(directory / filename, content.rstrip('\n') + '\n')
        seed[field] = filename
    ca_path = saved_input_path(directory, previous.get('caFile', 'appliance-ca.pem'))
    if ca_path.exists():
        private_read(ca_path)
        if ca_path != directory / 'appliance-ca.pem':
            import_file(ca_path, directory / 'appliance-ca.pem', ca=True)
        seed['caFile'] = 'appliance-ca.pem'
    else:
        # Local names cannot have WebPKI certificates. Find an already-local
        # public CA as a convenience, but never trust a downloaded server leaf.
        public_trust = False
        if not urlsplit(seed['dashboardUrl']).hostname.endswith('.local'):
            try:
                verified_identity(seed['dashboardUrl'])
                public_trust = True
            except (OSError, ssl.SSLError, SetupError):
                pass
        if not public_trust:
            candidate = keychain_appliance_ca(seed['dashboardUrl'])
            if candidate:
                print('A public certificate from the Mac keychain verifies this Dashboard.')
                trust_ca(candidate, directory / 'appliance-ca.pem')
            else:
                answer = input('First-contact trust: trusted Appliance CA PEM path (never a private key): ').strip()
                if not answer:
                    raise SetupError('First-contact HTTPS trust must be approved before sending admin credentials. Import a trusted CA; TLS is never ignored.')
                import_file(Path(answer).expanduser(), directory / 'appliance-ca.pem', ca=True)
            seed['caFile'] = 'appliance-ca.pem'
    seed['identityUrl'] = verified_identity(seed['dashboardUrl'], directory / seed['caFile'] if seed.get('caFile') else None)
    if not args.no_host_mapping:
        host_mapping(directory, seed, confirmed=True)
    if restoring:
        setup_api(directory, seed, 'restore')
        print('Previous Kubernetes access restored. Re-run ordinary setup to prepare scoped test credentials.')
        return
    facts = setup_api(directory, seed, 'inspect')
    seed.update({key: facts[key] for key in ['identityUrl', 'inferenceUrl', 'kubernetesApiUrl']})
    if not args.no_host_mapping:
        host_mapping(directory, seed, confirmed=True)
    print('Identity, Inference and Kubernetes endpoints discovered from verified login and authenticated APIs.')
    if any((directory / name).exists() for name in ['.setup-license-activation-pending.json', '.setup-model-stops.json']):
        print('WARNING: An earlier setup left an uncertain model/license action. Only exact recorded UIDs/revisions/document hashes can be reconciled; no action is retried.')
        if not yes_no('Independently check these private action receipts against this installation now?', False):
            raise SetupError('Review the pending setup action before any new writes or tests.')
        setup_api(directory, seed, 'recover-actions', facts, True)
    complete = not getattr(args, 'minimal', True)
    consent, signer_fixture = None, None
    if complete:
        facts = setup_api(directory, seed, 'suite-inventory', facts)
        consent = suite_consent(facts, previous.get('suiteConsent'))
        seed['suiteConsent'] = consent
        private_write(directory / 'setup.json', seed)
        profile = complete_fixtures(directory, seed, facts, consent)
        if set(consent['scopes']).intersection(['license', 'federation']):
            print('WARNING: A generated TEST-only Ed25519 key can be added to the optional LOCAL trust store on this lab.')
            print('Official issuer keys remain unchanged. No production signing key is requested or created.')
            if yes_no('Generate/reuse installation-bound signed test-license fixtures and provision their local public trust key?', True):
                signer_fixture = setup_api(directory, seed, 'license-fixtures', facts, True)['licenseFixture']
            else:
                profile.get('federation', {}).pop('testSignerFile', None)
                private_write(directory / 'remaining-p0.json', profile)
                for kind in ['valid', 'expired', 'wrong-installation', 'tampered', 'short-lived']:
                    filename = 'license-' + kind + '.license'
                    answer = question('Externally signed ' + kind + ' license path', optional=True)
                    if answer:
                        import_file(Path(answer).expanduser(), directory / filename)
        if (directory / 'appliance-ca.pem').exists():
            seed['caFile'] = 'appliance-ca.pem'
    approve_admin = False
    if facts['accessLevel'] != 'admin':
        print('This Dashboard admin does not yet have Kubernetes admin access. ONLY this account can be granted it temporarily for lab setup.')
        print('Existing sessions for this account are signed out by the API. Its previous access is restored before lab bootstrap.')
        approve_admin = input('Type GRANT to approve this temporary self-account change, or leave blank to stop: ').strip() == 'GRANT'
        if not approve_admin:
            raise SetupError('Temporary access was not approved. No Kubernetes rights were changed; existing manual setup remains available.')
    temporary = directory / '.setup-bootstrap.kubeconfig'
    try:
        if temporary.exists():
            private_read(temporary)
            temporary.unlink()
        setup_api(directory, seed, 'authorize', facts, approve_admin)
        bootstrap(temporary, directory, args.api_restart or bool(consent and 'api-restart' in consent['scopes']), expected_uid=facts['applianceUid'],
                  license_baseline=bool(consent and 'license' in consent['scopes']))
        if signer_fixture:
            provision_test_license_trust(temporary, directory, signer_fixture, facts['applianceUid'])
    finally:
        if temporary.exists() and not temporary.is_symlink():
            temporary.unlink()
    seed.update(observerKubeconfig='observer.yaml', modelCleanupKubeconfig='model-cleaner.yaml',
                lock={'namespace': 'magicstick-regression', 'name': 'lab-lock', 'kubeconfig': 'locker.yaml'})
    if args.advanced and not complete:
        additional_fixtures(directory, seed)
    private_write(directory / 'setup.json', seed)
    if complete:
        if 'modules' in consent['scopes'] and profile.get('modules', {}).get('id'):
            print('Preparing/verifying only the selected disabled optional-module fixture through the Dashboard API.')
            setup_api(directory, seed, 'module-fixture', facts, True)
        if signer_fixture:
            print('Verifying the generated license through the product API after local trust propagation (up to two minutes).')
            setup_api(directory, seed, 'verify-fixtures', facts, True)
        if facts['inventory']['activeModels']:
            print('WARNING: Existing local model definitions are active. They must be stopped for the isolated regression baseline.')
            print('Setup can stop exactly the discovered model UIDs/revisions. Definitions and cache remain; models stay stopped for the suite.')
            if yes_no('Stop these ' + str(len(facts['inventory']['activeModels'])) + ' reviewed local test models now?', False):
                setup_api(directory, seed, 'stop-models', facts, True)
        if profile.get('federation', {}).get('fixtures'):
            print('Setup does not activate a license. Phase 5 proves the no-file case, then activation, then federation.')
            if facts['inventory']['license']['hasDocument']:
                setup_api(directory, seed, 'export-license', facts)
            elif (directory / 'license-valid.license').exists():
                private_write(directory / 'license-original.license', private_read(directory / 'license-valid.license'))
        if not args.no_host_mapping:
            host_mapping(directory, seed, confirmed=True)
            application_dns(directory, seed, profile)
        private_write(directory / 'setup.json', seed)
        return finish_complete_setup(directory, seed)
    else:
        print('Minimal private setup complete. Separate test kubeconfigs were generated; no administrator token was retained.')
        print('Accepted lab/profile pins are unchanged. Next: bash tools/regression.sh prepare --phases 0-8')


def wizard(directory, args):
    if not getattr(args, 'manual', False) and not args.provision_rbac and not args.bootstrap_kubeconfig and not getattr(args, 'ca_kubeconfig', None):
        return automatic_wizard(directory, args)
    private_directory(directory)
    if (directory / '.preparation-accepting.json').exists():
        raise SetupError('An input acceptance was interrupted. Review its private previous-inputs backup before changing setup.')
    previous = {}
    for name in ['lab.json', 'setup.json']:
        if (directory / name).exists():
            previous.update(json.loads(private_read(directory / name)))
    seed = {'version': 1}
    for field, label in [('dashboardUrl', 'Dashboard HTTPS origin'), ('identityUrl', 'Identity HTTPS origin'),
                         ('inferenceUrl', 'Inference HTTPS origin')]:
        default = previous.get(field, '')
        answer = input(label + (' [keep existing]' if default else '') + ': ').strip()
        seed[field] = origin(answer or default)
    for field, filename, label in [('usernameFile', 'username.txt', 'Dashboard username'),
                                    ('passwordFile', 'password.txt', 'Dashboard password')]:
        previous_path = saved_input_path(directory, previous.get(field, filename))
        if previous_path.exists() and input('Reuse the saved ' + label.lower() + '? [Y/n]: ').strip().lower() != 'n':
            if previous_path != directory / filename:
                import_file(previous_path, directory / filename)
            else:
                private_read(previous_path)
        else:
            answer = hidden_password(label) if field == 'passwordFile' else input(label + ': ')
            if not answer or '\x00' in answer or '\n' in answer or '\r' in answer:
                raise SetupError('Credentials cannot be empty or contain line breaks.')
            private_write(directory / filename, answer + '\n')
        seed[field] = filename
    ca = previous.get('caFile', 'appliance-ca.pem')
    ca_path = saved_input_path(directory, ca)
    ca_source = getattr(args, 'ca_kubeconfig', None)
    if ca_source:
        trust_ca(appliance_ca_from_kubeconfig(Path(ca_source).expanduser(), seed['identityUrl']), directory / 'appliance-ca.pem')
        seed['caFile'] = 'appliance-ca.pem'
    elif ca_path.exists() and input('Reuse the existing trusted dashboard CA? [Y/n]: ').strip().lower() != 'n':
        private_read(ca_path)
        if ca_path != directory / 'appliance-ca.pem':
            import_file(ca_path, directory / 'appliance-ca.pem', ca=True)
        seed['caFile'] = 'appliance-ca.pem'
    else:
        answer = input('Trusted CA PEM path (blank ONLY for a public WebPKI certificate): ').strip()
        if answer:
            import_file(Path(answer).expanduser(), directory / 'appliance-ca.pem', ca=True)
            seed['caFile'] = 'appliance-ca.pem'
        elif args.bootstrap_kubeconfig and input('Import the public Appliance CA from the selected bootstrap kubeconfig? [Y/n]: ').strip().lower() != 'n':
            trust_ca(appliance_ca_from_kubeconfig(Path(args.bootstrap_kubeconfig).expanduser(), seed['identityUrl']), directory / 'appliance-ca.pem')
            seed['caFile'] = 'appliance-ca.pem'
    if not seed.get('caFile') and any(urlsplit(seed[field]).hostname.endswith('.local')
                                    for field in ['dashboardUrl', 'identityUrl', 'inferenceUrl']):
        raise SetupError('.local endpoints require the approved Appliance CA. Import a trusted PEM or use --ca-kubeconfig PATH; blank does not bypass TLS.')
    if args.provision_rbac:
        if not args.bootstrap_kubeconfig:
            raise SetupError('--provision-rbac requires --bootstrap-kubeconfig PATH; no ambient admin context is used.')
        bootstrap(Path(args.bootstrap_kubeconfig).expanduser(), directory, args.api_restart)
    elif args.bootstrap_kubeconfig or args.api_restart:
        raise SetupError('Bootstrap flags require --provision-rbac.')
    else:
        selected = {}
        for filename, label in [('observer.yaml', 'Read-only observer kubeconfig'), ('locker.yaml', 'Single-Lease locker kubeconfig'),
                                ('model-cleaner.yaml', 'Model-intent cleaner kubeconfig')]:
            destination = directory / filename
            answer = input(label + (' path [keep existing]' if destination.exists() else ' path') + ': ').strip()
            content = private_read(Path(answer).expanduser() if answer else destination)
            role_credential(content)
            selected[filename] = content
        if len({hashlib.sha256(content.encode('utf-8')).digest() for content in selected.values()}) != 3:
            raise SetupError('Observer, Lease locker and model cleaner need distinct scoped credentials, not three copies of an admin kubeconfig. Use --provision-rbac with a selected bootstrap kubeconfig.')
        for filename, content in selected.items():
            private_write(directory / filename, content)
    seed.update(observerKubeconfig='observer.yaml', modelCleanupKubeconfig='model-cleaner.yaml',
                lock={'namespace': 'magicstick-regression', 'name': 'lab-lock', 'kubeconfig': 'locker.yaml'})
    if args.advanced:
        additional_fixtures(directory, seed)
    if not args.no_host_mapping:
        host_mapping(directory, seed)
    private_write(directory / 'setup.json', seed)
    print('Private setup saved. Existing accepted lab/profile pins were not replaced.')
    print('Next: bash tools/regression.sh prepare --phases 0-8')


def registered_setup(directory, args):
    """One lab registration; subsequent refreshes have no stdin or approvals.

    The command itself selects a disposable target. Refresh can never register
    a replacement installation or accept a different Appliance/Node identity.
    """
    private_directory(directory)
    saved = json.loads(private_read(directory / 'setup.json')) if (directory / 'setup.json').exists() else {}
    registration_path = directory / 'lab-registration.json'
    registration = json.loads(private_read(registration_path)) if registration_path.exists() else None
    pending_path = directory / '.setup-registration-pending.json'
    pending = json.loads(private_read(pending_path)) if pending_path.exists() else None
    refresh = args.refresh
    if refresh and not registration:
        raise SetupError('This server is not registered as a disposable test lab. Run setup once; all never registers a new target.')
    if refresh and not saved.get('dashboardUrl'):
        raise SetupError('The saved registered lab endpoint is unavailable; no interactive fallback is used.')
    if pending and (not registration or pending != {'version': 1, 'registrationId': registration.get('id')}):
        raise SetupError('The interrupted registration does not match this saved lab. No new target was registered.')
    seed = dict(saved)
    seed['dashboardUrl'] = origin(args.url or saved.get('dashboardUrl') or
                                  question('Dedicated TEST server HTTPS URL', 'https://magicstick.local'))
    if args.username:
        private_write(directory / 'username.txt', args.username + '\n')
    elif not (directory / 'username.txt').exists():
        if refresh:
            raise SetupError('Saved test administrator credentials are unavailable.')
        private_write(directory / 'username.txt', question('Test administrator username', 'admin') + '\n')
    if args.password_file:
        import_file(Path(args.password_file).absolute(), directory / 'password.txt', automatic=True)
    elif not (directory / 'password.txt').exists():
        if refresh:
            raise SetupError('Saved test administrator credentials are unavailable.')
        private_write(directory / 'password.txt', hidden_password('Test administrator password: ') + '\n')
    seed.update(usernameFile='username.txt', passwordFile='password.txt')
    if args.ca_file:
        import_file(Path(args.ca_file).absolute(), directory / 'appliance-ca.pem', ca=True, automatic=True)
        seed['caFile'] = 'appliance-ca.pem'
    ca = saved_input_path(directory, seed['caFile']) if seed.get('caFile') else None
    try:
        seed['identityUrl'] = verified_identity(seed['dashboardUrl'], ca)
    except (OSError, ssl.SSLError, SetupError):
        if refresh:
            raise SetupError('Verified test-server TLS/DNS is unavailable. Restore reachability or the trusted CA; no insecure fallback.') from None
        certificate = keychain_appliance_ca(seed['dashboardUrl'])
        if certificate:
            # Only import a certificate already trusted by the macOS system.
            with tempfile.NamedTemporaryFile(mode='w', suffix='.pem') as check:
                check.write(certificate)
                check.flush()
                trusted = subprocess.run(['/usr/bin/security', 'verify-cert', '-c', check.name, '-p', 'basic'],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if trusted.returncode == 0:
                trust_ca(certificate, directory / 'appliance-ca.pem', automatic=True)
                seed['caFile'] = 'appliance-ca.pem'
        if not seed.get('caFile'):
            path = question('Trusted Appliance CA PEM path (certificate trust is required)', check=lambda value: bool(value))
            import_file(Path(path).absolute(), directory / 'appliance-ca.pem', ca=True, automatic=True)
            seed['caFile'] = 'appliance-ca.pem'
        seed['identityUrl'] = verified_identity(seed['dashboardUrl'], directory / 'appliance-ca.pem')
    if registration and (registration['dashboardUrl'] != seed['dashboardUrl'] or registration['identityUrl'] != seed['identityUrl']):
        raise SetupError('The endpoint does not match this registered lab. Use a separate private input directory for another test server.')
    if not args.no_host_mapping:
        host_mapping(directory, seed, confirmed=True)
    if (directory / '.setup-access-restore.json').exists():
        setup_api(directory, seed, 'restore')
    # A retained transient admin config is never adopted or mounted in suites.
    transient = directory / '.setup-bootstrap.kubeconfig'
    if transient.exists():
        private_read(transient)
        transient.unlink()
    facts = setup_api(directory, seed, 'inspect')
    facts = setup_api(directory, seed, 'suite-inventory', facts)
    nodes = sorted({node['nodeUid'] for node in facts['inventory']['nodes']})
    if not nodes or registration and (registration['applianceUid'] != facts['applianceUid'] or registration['nodeUids'] != nodes):
        raise SetupError('This is not the registered Appliance/Node installation. No permissions or test actions were applied.')
    if not registration:
        print('Registering a DISPOSABLE test server. Full runs may stop models, change settings, clear model caches and reboot it.')
        registration = {'version': 1, 'kind': 'disposable-regression-lab', 'policyVersion': 1, 'id': str(uuid.uuid4()),
                        'applianceUid': facts['applianceUid'], 'nodeUids': nodes, 'dashboardUrl': seed['dashboardUrl'],
                        'identityUrl': seed['identityUrl'], 'createdAt': datetime.now(timezone.utc).isoformat()}
        private_write(registration_path, registration)
    seed.update(inferenceUrl=facts['inferenceUrl'], kubernetesApiUrl=facts['kubernetesApiUrl'],
                registrationFile='lab-registration.json', observerKubeconfig='observer.yaml',
                modelCleanupKubeconfig='model-cleaner.yaml',
                lock={'kubeconfig': 'locker.yaml', 'namespace': 'magicstick-regression', 'name': 'lab-lock'})
    private_write(directory / 'setup.json', seed)
    if not args.no_host_mapping:
        host_mapping(directory, seed, confirmed=True)
    # Retry an interrupted first registration only for the same already-bound
    # Appliance/Node IDs. A normal refresh can never create a replacement lab.
    bootstrap_mode = 'register' if not refresh or pending else 'refresh'
    if bootstrap_mode == 'register':
        private_write(pending_path, {'version': 1, 'registrationId': registration['id']})
    bootstrapped = setup_api(directory, seed, bootstrap_mode, facts, approve_admin=True)
    recovered = bootstrapped.get('recoveredRunIds', [])
    if not isinstance(recovered, list) or len(recovered) > 64 or any(not isinstance(item, str) or not re.fullmatch(r'reg-[0-9a-f-]{36}', item) for item in recovered):
        raise SetupError('Invalid automatic recovery confirmation.', code='CONFIG')
    RECOVERED_RUN_IDS.extend(item for item in recovered if item not in RECOVERED_RUN_IDS)
    if recovered:
        print('Previous interrupted regression run automatically restored; original failed report retained.')
    if pending_path.exists():
        private_read(pending_path)
        pending_path.unlink()
    setup_api(directory, seed, 'recover-actions', facts, approve_admin=True)
    if facts['inventory']['license']['hasDocument']:
        setup_api(directory, seed, 'export-license', facts)
    if facts['inventory']['activeModels']:
        setup_api(directory, seed, 'stop-models', facts, approve_admin=True)
    plugin = directory / 'kubectl-oidc_login'
    architecture = facts['inventory']['runnerArchitecture']
    plugin_receipt = directory / 'oidc-plugin.json'
    if not plugin.exists() or not plugin_receipt.exists():
        downloaded = download_oidc_plugin(directory, architecture, automatic=True)
        digest = oidc_plugin(downloaded, plugin, automatic=True, architecture=architecture)
        downloaded.unlink()
        private_write(plugin_receipt, {'version': 1, 'upstreamVersion': 'v1.36.4', 'architecture': architecture, 'sha256': digest})
    else:
        # Revalidate architecture, ELF format and file permissions on every run.
        receipt = json.loads(private_read(plugin_receipt))
        if receipt.get('version') != 1 or receipt.get('upstreamVersion') != 'v1.36.4' or receipt.get('architecture') != architecture or \
                plugin.is_symlink() or stat.S_IMODE(plugin.stat().st_mode) != 0o700 or \
                hashlib.sha256(plugin.read_bytes()).hexdigest() != receipt.get('sha256'):
            raise SetupError('The pinned OIDC helper changed unexpectedly. No executable was adopted.', 'Failed')
        oidc_plugin(plugin, directory / '.oidc-verified', automatic=True, architecture=architecture)
        (directory / '.oidc-verified').unlink()
    profile = json.loads(private_read(directory / 'remaining-p0.json')) if (directory / 'remaining-p0.json').exists() else {'version': 1}
    profile['kubernetes'] = {'approveAdminGrant': True, 'plugin': {'filename': '/inputs/kubectl-oidc_login',
                                                               'sha256': hashlib.sha256(plugin.read_bytes()).hexdigest()}}
    private_write(directory / 'remaining-p0.json', profile)
    run_preparation(directory, ['--automatic'])
    profile = json.loads(private_read(directory / 'remaining-p0.json'))
    if profile.get('modules', {}).get('id'):
        setup_api(directory, seed, 'module-fixture', facts, approve_admin=True)
    # Test-owned application names are generated later; map only their bounded
    # registered lab suffix, keeping certificate verification fully enabled.
    host = urlsplit(seed['dashboardUrl']).hostname
    mappings = []
    if host.endswith('.local'):
        values = {item[4][0] for item in socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)}
        if len(values) != 1:
            raise SetupError('The registered lab has ambiguous DNS; no arbitrary address was selected.')
        mappings = [{'suffix': item['originTemplate'].split('{name}.', 1)[1].rstrip('/'), 'address': next(iter(values))}
                    for item in profile.get('applications', {}).get('fixtures', [])]
    private_write(directory / 'browser-dns.json', {'version': 1, 'mappings': mappings})
    print('Test lab ready. Next: bash tools/regression.sh all')
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manual', action='store_true', help='Advanced legacy wizard: explicitly select origins, CA and role credentials; no Docker needed')
    parser.add_argument('--minimal', action='store_true', help='Save only credentials/scoped RBAC; skip the complete suite forms, saved consent and final acceptance')
    parser.add_argument('--restore-kubernetes-access', action='store_true', help='Restore only the exact prior self-account access from an interrupted automatic setup')
    parser.add_argument('--provision-rbac', action='store_true', help='Explicitly bootstrap/renew only reviewed lab grants and tokens')
    parser.add_argument('--bootstrap-kubeconfig', help='Selected private administrator kubeconfig; never copied or retained')
    parser.add_argument('--ca-kubeconfig', help='Import only the public identity CA from a selected Magic Stick OIDC kubeconfig after fingerprint review')
    parser.add_argument('--api-restart', action='store_true', help='Also grant separate API-Pod restart permission for approved license tests')
    parser.add_argument('--advanced', action='store_true', help='One-time questions/imports for app UI adapters, OIDC plugin, signed licenses, optional module and Mesh peer')
    parser.add_argument('--no-host-mapping', action='store_true', help='Keep externally managed Docker DNS/host mappings unchanged')
    parser.add_argument('--refresh', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--url', help='Dedicated disposable test-server HTTPS origin')
    parser.add_argument('--username', help='Test administrator username')
    parser.add_argument('--password-file', help='Private file containing the test administrator password (never a command-line password)')
    parser.add_argument('--ca-file', help='Already trusted appliance CA PEM; required if the system does not trust its certificate')
    args = parser.parse_args(argv)
    if args.restore_kubernetes_access and (args.manual or args.provision_rbac or args.bootstrap_kubeconfig or args.ca_kubeconfig or args.api_restart or args.advanced):
        parser.error('Access restoration cannot be combined with manual/selected-context bootstrap flags.')
    os.umask(0o077)
    try:
        directory = Path(os.environ.get('REGRESSION_INPUT_DIR', str(ROOT / '.regression/inputs'))).absolute()
        legacy = args.manual or args.minimal or args.restore_kubernetes_access or args.provision_rbac or args.bootstrap_kubeconfig or args.ca_kubeconfig or args.advanced
        result = wizard(directory, args) if legacy else registered_setup(directory, args)
        preparation_status('Blocked' if result is False else 'Passed')
        return 2 if result is False else 0
    except SetupError as error:
        try:
            preparation_status(error.outcome, error)
        except (SetupError, OSError):
            pass  # Never replace the primary safe reason with raw file errors.
        print(str(error), file=sys.stderr)
        return 1 if error.outcome == 'Failed' else 2
    except (OSError, ValueError, KeyError, TypeError, AttributeError, EOFError, KeyboardInterrupt):
        # Do not stringify arbitrary exceptions: paths and subprocess/API output
        # can contain credentials. All failed writes remain private/recoverable.
        try:
            preparation_status('Blocked', SetupError('Setup stopped.', code='PREREQUISITE'))
        except (SetupError, OSError):
            pass
        print('Setup stopped. Check test-server reachability, trusted certificates and private file permissions; no insecure or admin fallback.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
