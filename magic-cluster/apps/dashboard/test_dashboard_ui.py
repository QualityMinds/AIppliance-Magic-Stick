#!/usr/bin/env python3
"""Focused source and syntax tests for the embedded dashboard user-management UI."""

from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest


CONFIGMAP = Path(__file__).with_name("configmap.yaml")


def dashboard_source():
    return CONFIGMAP.read_text(encoding="utf-8")


def embedded_script(source):
    start = source.index("      <script>") + len("      <script>")
    end = source.index("      </script>", start)
    return textwrap.dedent(source[start:end])


def rendered_dashboard_html(source):
    """Reconstruct the HTML emitted by render.sh without running its loop."""
    first_marker = "      cat <<'HTML' > \"$tmp\"\n"
    second_marker = "      cat <<'HTML' >> \"$tmp\"\n"
    first_start = source.index(first_marker) + len(first_marker)
    first_end = source.index("\n    HTML", first_start)
    second_start = source.index(second_marker, first_end) + len(second_marker)
    second_end = source.index("\n    HTML", second_start)
    first = textwrap.dedent(source[first_start:first_end])
    second = textwrap.dedent(source[second_start:second_end])
    return first + "\nBrowser test render\n" + second


def chrome_executable():
    candidates = [
        shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return None


BROWSER_API_MOCK = r"""
(() => {
  const scenario = new URLSearchParams(window.location.search).get('scenario') || 'admin';
  const roleByScenario = {
    admin: ['magicstick-admin'],
    viewer: ['magicstick-viewer'],
    operator: ['magicstick-operator'],
    unavailable: ['magicstick-admin']
  };
  const managedRoles = {
    user: ['magicstick-user'],
    viewer: ['magicstick-user', 'magicstick-viewer'],
    operator: ['magicstick-user', 'magicstick-operator'],
    admin: ['magicstick-user', 'magicstick-admin']
  };
  let mockUser = null;
  window.__dashboardBrowserCalls = [];
  window.setInterval = () => 0;

  const capabilities = (enabled = true) => ({
    canEditProfile: true,
    canManageRoles: true,
    canEnable: !enabled,
    canDisable: enabled,
    canResetPassword: true,
    canDelete: true,
    isSelf: false,
    isProtected: false
  });
  const reply = (payload, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Mock error',
    json: async () => payload
  });

  window.fetch = async (rawPath, options = {}) => {
    const url = new URL(String(rawPath), window.location.href);
    const path = url.pathname + url.search;
    const method = String(options.method || 'GET').toUpperCase();
    let body = null;
    if (options.body) {
      try { body = JSON.parse(options.body); } catch (error) { body = options.body; }
    }
    window.__dashboardBrowserCalls.push({ path, method, headers: options.headers || {}, body });

    if (url.pathname === '/api/session') {
      return reply({
        subject: scenario + '-subject',
        username: scenario,
        roles: roleByScenario[scenario] || [],
        identityManagementAvailable: scenario !== 'unavailable',
        identityManagementMode: scenario === 'unavailable' ? 'external' : 'keycloak'
      });
    }
    if (url.pathname === '/api/settings') {
      return reply({
        publicDomain: 'magicstick.example.com',
        dashboardHost: 'magicstick.example.com',
        mdnsDomain: 'magicstick.local',
        mdnsName: 'magicstick'
      });
    }
    if (url.pathname === '/api/appliance') {
      return reply({ metadata: { namespace: 'ai-system', name: 'local' }, status: { phase: 'Ready' } });
    }
    if (url.pathname === '/api/modules') {
      return reply({
        modules: {
          litellm: {
            enabled: true,
            activationMode: 'moduleactivation',
            displayName: 'LiteLLM',
            status: { phase: 'Ready' }
          }
        },
        catalogJson: {
          modules: {
            litellm: { displayName: 'LiteLLM', activationMode: 'moduleactivation', order: 50 }
          },
          groups: {},
          applications: {}
        }
      });
    }
    if (url.pathname === '/api/instances') {
      return reply({
        instances: {
          openclaw: [{
            metadata: { name: 'openclaw-demo' },
            spec: { application: 'openclaw', enabled: true },
            status: { phase: 'Ready' }
          }]
        }
      });
    }
    if (url.pathname === '/api/models') {
      return reply({ models: [], activations: [], presets: [], vram: { available: false } });
    }
    if (url.pathname === '/api/status') {
      return reply({
        fluxKustomizations: [],
        pods: [],
        services: [],
        ingresses: [],
        httpRoutes: [
          {
            namespace: 'identity-system',
            name: 'static-litellm-local',
            labels: {},
            hostnames: ['litellm.magicstick.local'],
            accepted: true
          },
          {
            namespace: 'identity-system',
            name: 'static-litellm-local-callback',
            labels: {},
            hostnames: ['magicstick.local'],
            accepted: true
          },
          {
            namespace: 'identity-system',
            name: 'openclaw-demo-local',
            labels: { 'appliance.magicstick.dev/appinstance': 'openclaw-demo' },
            hostnames: ['demo.openclaw.magicstick.local'],
            accepted: true
          },
          {
            namespace: 'identity-system',
            name: 'static-litellm-pending',
            labels: { 'app.kubernetes.io/name': 'litellm' },
            hostnames: ['pending.magicstick.example.com'],
            accepted: false
          }
        ],
        events: []
      });
    }
    if (url.pathname === '/api/users' && method === 'GET') {
      return reply({ users: mockUser ? [mockUser] : [], total: mockUser ? 1 : 0, first: 0, max: 25 });
    }
    if (url.pathname === '/api/users/u-1' && method === 'GET') {
      return reply(mockUser || { error: 'not found' }, mockUser ? 200 : 404);
    }
    if (url.pathname === '/api/users' && method === 'POST') {
      mockUser = {
        id: 'u-1',
        username: body.username,
        firstName: body.firstName,
        lastName: body.lastName,
        displayName: [body.firstName, body.lastName].filter(Boolean).join(' '),
        email: body.email,
        emailVerified: false,
        enabled: body.enabled,
        createdAt: 1700000000000,
        source: 'local',
        provider: 'local',
        directRoles: managedRoles[body.accessLevel],
        effectiveRoles: managedRoles[body.accessLevel],
        accessLevel: body.accessLevel,
        effectiveAccessLevel: body.accessLevel,
        capabilities: capabilities(body.enabled)
      };
      return reply(mockUser, 201);
    }
    if (url.pathname === '/api/users/u-1' && method === 'PATCH') {
      Object.assign(mockUser, body, {
        displayName: [body.firstName, body.lastName].filter(Boolean).join(' ')
      });
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/roles' && method === 'PUT') {
      mockUser.accessLevel = body.accessLevel;
      mockUser.effectiveAccessLevel = body.accessLevel;
      mockUser.directRoles = managedRoles[body.accessLevel];
      mockUser.effectiveRoles = managedRoles[body.accessLevel];
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/disable' && method === 'POST') {
      mockUser.enabled = false;
      mockUser.capabilities = capabilities(false);
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/enable' && method === 'POST') {
      mockUser.enabled = true;
      mockUser.capabilities = capabilities(true);
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/password' && method === 'PUT') {
      return reply({ id: 'u-1', passwordReset: true, temporary: true });
    }
    if (url.pathname === '/api/users/u-1' && method === 'DELETE') {
      if (!body || body.usernameConfirmation !== mockUser.username) {
        return reply({ error: 'username confirmation is invalid' }, 400);
      }
      mockUser = null;
      return reply({ deleted: 'u-1' });
    }
    return reply({ error: 'unmocked request: ' + method + ' ' + url.pathname }, 404);
  };
})();
"""


BROWSER_ASSERTIONS = r"""
(() => {
  const result = document.createElement('pre');
  result.id = 'browser-test-result';
  result.dataset.status = 'running';
  document.body.appendChild(result);
  const scenario = new URLSearchParams(window.location.search).get('scenario') || 'admin';
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (predicate, message, attempts = 300) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) { return; }
      await sleep(10);
    }
    throw new Error('Timed out: ' + message);
  };
  const assert = (condition, message) => {
    if (!condition) { throw new Error(message); }
  };
  const callExists = (method, path) => window.__dashboardBrowserCalls.some((call) => call.method === method && call.path.split('?')[0] === path);
  const actionButton = async (action) => {
    await waitFor(() => {
      const button = document.querySelector('[data-user-action="' + action + '"]');
      return button && !button.disabled;
    }, action + ' action');
    return document.querySelector('[data-user-action="' + action + '"]');
  };

  (async () => {
    await waitFor(() => document.getElementById('session-user').textContent.includes('Signed in: '), 'dashboard refresh');
    await waitFor(() => document.querySelectorAll('.overview-url-link').length === 2, 'overview URLs');
    const overviewUrls = Array.from(document.querySelectorAll('.overview-url-link')).map((link) => link.textContent);
    assert(overviewUrls.includes('https://litellm.magicstick.local'), 'module URL is missing');
    assert(overviewUrls.includes('https://demo.openclaw.magicstick.local'), 'instance URL is missing');
    assert(!overviewUrls.includes('https://magicstick.local'), 'OIDC callback route leaked into module URLs');
    assert(!overviewUrls.includes('https://pending.magicstick.example.com'), 'unaccepted HTTPRoute was shown');
    assert(document.getElementById('overview-app-count').textContent === '2 URLs', 'overview URL count is incorrect');
    const usersTab = document.getElementById('users-tab-button');
    assert(usersTab, 'Users tab is missing from the rendered DOM');

    if (scenario !== 'admin') {
      assert(usersTab.hidden, scenario + ' must not see the Users tab');
      assert(!window.__dashboardBrowserCalls.some((call) => call.path.startsWith('/api/users')), 'hidden tab must not load users');
      result.dataset.status = 'passed';
      result.textContent = 'passed:' + scenario;
      return;
    }

    assert(!usersTab.hidden, 'administrator cannot see the Users tab');
    usersTab.click();
    await waitFor(() => callExists('GET', '/api/users'), 'lazy user list request');
    const createButton = document.getElementById('user-create');
    assert(createButton && !createButton.hidden && !createButton.closest('[hidden]'), 'Create User button is not visible');
    assert(window.getComputedStyle(createButton).display !== 'none', 'Create User button is not rendered');

    createButton.click();
    const editorDialog = document.getElementById('user-editor-dialog');
    await waitFor(() => editorDialog.open, 'Create User dialog');
    await sleep(20);
    assert(document.activeElement === editorDialog.querySelector('input[name="username"]'), 'Create User dialog did not receive focus');
    const editor = document.getElementById('user-editor-form');
    editor.elements.username.value = 'browser-user';
    editor.elements.firstName.value = 'Browser';
    editor.elements.lastName.value = 'User';
    editor.elements.email.value = 'browser.user@example.com';
    editor.elements.accessLevel.value = 'viewer';
    editor.elements.password.value = 'temporary-Password-123!';
    editor.elements.passwordConfirmation.value = 'temporary-Password-123!';
    editor.requestSubmit();
    await waitFor(() => callExists('POST', '/api/users') && !editorDialog.open, 'create request');
    await waitFor(() => document.querySelector('[data-user-action="edit"]'), 'created user row');

    (await actionButton('edit')).click();
    await waitFor(() => editorDialog.open && callExists('GET', '/api/users/u-1'), 'edit dialog');
    editor.elements.firstName.value = 'Updated';
    editor.requestSubmit();
    await waitFor(() => callExists('PATCH', '/api/users/u-1') && !editorDialog.open, 'profile update request');

    (await actionButton('roles')).click();
    const roleDialog = document.getElementById('user-role-dialog');
    await waitFor(() => roleDialog.open, 'role dialog');
    const roleForm = document.getElementById('user-role-form');
    roleForm.elements.accessLevel.value = 'operator';
    roleForm.requestSubmit();
    await waitFor(() => callExists('PUT', '/api/users/u-1/roles') && !roleDialog.open, 'role update request');

    (await actionButton('disable')).click();
    const confirmDialog = document.getElementById('user-confirm-dialog');
    await waitFor(() => confirmDialog.open, 'disable confirmation');
    document.getElementById('user-confirm-form').requestSubmit();
    await waitFor(() => callExists('POST', '/api/users/u-1/disable') && !confirmDialog.open, 'disable request');

    (await actionButton('enable')).click();
    await waitFor(() => confirmDialog.open, 'enable confirmation');
    document.getElementById('user-confirm-form').requestSubmit();
    await waitFor(() => callExists('POST', '/api/users/u-1/enable') && !confirmDialog.open, 'enable request');

    (await actionButton('password')).click();
    const passwordDialog = document.getElementById('user-password-dialog');
    await waitFor(() => passwordDialog.open, 'password dialog');
    const passwordForm = document.getElementById('user-password-form');
    passwordForm.elements.password.value = 'replacement-Password-123!';
    passwordForm.elements.passwordConfirmation.value = 'replacement-Password-123!';
    passwordForm.requestSubmit();
    await waitFor(() => callExists('PUT', '/api/users/u-1/password') && !passwordDialog.open, 'password reset request');

    (await actionButton('delete')).click();
    await waitFor(() => confirmDialog.open, 'delete confirmation');
    const confirmForm = document.getElementById('user-confirm-form');
    confirmForm.elements.usernameConfirmation.value = 'browser-user';
    confirmForm.requestSubmit();
    await waitFor(() => callExists('DELETE', '/api/users/u-1') && !confirmDialog.open, 'delete request');

    const expectedCalls = [
      ['POST', '/api/users'],
      ['GET', '/api/users/u-1'],
      ['PATCH', '/api/users/u-1'],
      ['PUT', '/api/users/u-1/roles'],
      ['POST', '/api/users/u-1/disable'],
      ['POST', '/api/users/u-1/enable'],
      ['PUT', '/api/users/u-1/password'],
      ['DELETE', '/api/users/u-1']
    ];
    expectedCalls.forEach(([method, path]) => assert(callExists(method, path), 'missing ' + method + ' ' + path));
    const mutations = window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/users') && !['GET', 'HEAD'].includes(call.method));
    assert(mutations.every((call) => call.headers['X-MagicStick-CSRF'] === 'dashboard'), 'a user mutation omitted the CSRF header');
    assert(mutations.every((call) => call.headers['Content-Type'] === 'application/json'), 'a user mutation omitted JSON content type');
    const roleUpdate = mutations.find((call) => call.method === 'PUT' && call.path === '/api/users/u-1/roles');
    assert(roleUpdate && roleUpdate.body.accessLevel === 'operator', 'role update did not preserve the selected access level');
    const deletion = mutations.find((call) => call.method === 'DELETE');
    assert(deletion && deletion.body.usernameConfirmation === 'browser-user', 'delete confirmation body is missing');

    result.dataset.status = 'passed';
    result.textContent = 'passed:' + scenario;
  })().catch((error) => {
    result.dataset.status = 'failed';
    result.textContent = 'failed:' + scenario + ':' + (error && error.message ? error.message : String(error));
  });
})();
"""


def instrumented_dashboard_html(source):
    html = rendered_dashboard_html(source).replace("setInterval(refresh, 30000);", "")
    html = html.replace(
        "<script>",
        "<script>\n" + BROWSER_API_MOCK + "\n</script>\n<script>",
        1,
    )
    return html.replace(
        "</body>",
        "<script>\n" + BROWSER_ASSERTIONS + "\n</script>\n</body>",
        1,
    )


class DashboardUserManagementUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = dashboard_source()
        cls.script = embedded_script(cls.source)

    def test_embedded_javascript_is_valid(self):
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        result = subprocess.run(
            ["node", "--check"],
            input=self.script,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_users_tab_is_admin_gated_and_create_button_is_visible(self):
        self.assertIn('id="users-tab-button"', self.source)
        self.assertIn('id="users-tab-button" type="button" aria-selected="false" data-tab="users" hidden', self.source)
        self.assertIn('id="user-create" type="button">Create User</button>', self.source)
        self.assertIn("roles.includes('magicstick-admin')", self.script)
        self.assertIn("identityManagementAvailable !== false", self.script)

    def test_overview_shows_full_module_and_instance_urls_from_http_routes(self):
        self.assertIn("<h3>Available URLs</h3>", self.source)
        self.assertIn("const linksFromHttpRoute", self.script)
        self.assertIn("(status || {}).httpRoutes", self.script)
        self.assertIn("anchor.textContent = link.url", self.script)
        self.assertIn("seenLinks.size === 1 ? ' URL' : ' URLs'", self.script)
        self.assertIn("No module or instance URLs discovered yet.", self.script)

    def test_overview_url_discovery_matches_routes_and_excludes_callbacks(self):
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        start = self.script.index("const ensureHttpUrl")
        end = self.script.index("const copyText", start)
        functions = self.script[start:end]
        probe = functions + r"""
const statusPayload = {
  ingresses: [],
  httpRoutes: [
    { name: 'static-litellm-local', labels: {}, hostnames: ['litellm.magicstick.local'], accepted: true },
    { name: 'static-litellm-local-callback', labels: {}, hostnames: ['magicstick.local'], accepted: true },
    { name: 'static-litellm-pending', labels: { 'app.kubernetes.io/name': 'litellm' }, hostnames: ['pending.magicstick.example.com'], accepted: false },
    { name: 'openclaw-demo-local', labels: { 'appliance.magicstick.dev/appinstance': 'openclaw-demo' }, hostnames: ['demo.openclaw.magicstick.local'], accepted: true }
  ]
};
const moduleLinks = moduleAccessLinks('litellm', { activationMode: 'moduleactivation' }, statusPayload);
const instanceLinks = instanceAccessLinks({
  metadata: { name: 'openclaw-demo' },
  spec: { application: 'openclaw' },
  status: { phase: 'Ready' }
}, statusPayload);
process.stdout.write(JSON.stringify({
  module: moduleLinks.map((link) => link.url),
  instance: instanceLinks.map((link) => link.url)
}));
"""
        completed = subprocess.run(
            ["node"],
            input=probe,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        links = json.loads(completed.stdout)
        self.assertEqual(links["module"], ["https://litellm.magicstick.local"])
        self.assertEqual(links["instance"], ["https://demo.openclaw.magicstick.local"])

    def test_users_are_lazy_loaded_outside_the_global_refresh(self):
        refresh = self.script.split("const refresh = async () => {", 1)[1].split("document.querySelectorAll('.tab-button')", 1)[0]
        self.assertNotIn("/api/users", refresh)
        self.assertIn("if (button.dataset.tab === 'users')", self.script)
        self.assertIn("await loadUsers(false)", self.script)

    def test_user_api_contract_and_csrf_header_are_present(self):
        for endpoint in (
            "/api/users?",
            "/api/users/",
            "/roles",
            "/password",
        ):
            self.assertIn(endpoint, self.script)
        for method in ("'POST'", "'PATCH'", "'PUT'", "'DELETE'"):
            self.assertIn("method: " + method, self.script)
        self.assertIn("headers['X-MagicStick-CSRF'] = 'dashboard'", self.script)
        self.assertIn("body: JSON.stringify({ usernameConfirmation })", self.script)

    def test_role_form_captures_access_before_disabling_controls(self):
        handler = self.script.split("const userRoleForm = $('user-role-form');", 1)[1]
        handler = handler.split("const userPasswordForm = $('user-password-form');", 1)[0]

        capture = "const data = new FormData(userRoleForm);"
        disable = "setDialogBusy(userRoleForm, true);"
        self.assertIn(capture, handler)
        self.assertIn("const accessLevel = String(data.get('accessLevel') || 'user');", handler)
        self.assertLess(handler.index(capture), handler.index(disable))
        self.assertIn("body: JSON.stringify({ accessLevel })", handler)

    def test_user_supplied_values_use_dom_text_not_html(self):
        user_code = self.script.split("const sessionIsUserAdmin", 1)[1].split("const renderStatus", 1)[0]
        self.assertNotIn("innerHTML", user_code)
        self.assertIn("textContent", user_code)
        self.assertIn("list.replaceChildren()", user_code)

    def test_password_inputs_are_temporary_and_scrubbed(self):
        self.assertGreaterEqual(self.source.count('autocomplete="new-password"'), 4)
        self.assertIn("temporary: true", self.script)
        self.assertIn("clearPasswordInputs(userEditorForm)", self.script)
        self.assertIn("clearPasswordInputs(userPasswordForm)", self.script)

    def test_user_management_in_a_real_headless_browser(self):
        if os.environ.get("MAGICSTICK_RUN_BROWSER_TESTS") != "1":
            self.skipTest("set MAGICSTICK_RUN_BROWSER_TESTS=1 to run the Chrome DOM test")
        chrome = chrome_executable()
        if not chrome:
            self.skipTest("Chrome or Chromium is not installed")
        with tempfile.TemporaryDirectory(prefix="magicstick-dashboard-ui-") as temporary_directory:
            directory = Path(temporary_directory)
            page = directory / "dashboard-test.html"
            page.write_text(instrumented_dashboard_html(self.source), encoding="utf-8")
            scenarios = ("admin", "viewer", "operator", "unavailable")

            for scenario in scenarios:
                profile = directory / ("chrome-" + scenario)
                command = [
                    chrome,
                    "--headless=new",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-crash-reporter",
                    "--disable-default-apps",
                    "--disable-extensions",
                    "--disable-gpu",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--no-first-run",
                    "--no-sandbox",
                    "--allow-file-access-from-files",
                    "--virtual-time-budget=1000",
                    "--user-data-dir=" + str(profile),
                    "--dump-dom",
                    page.as_uri() + "?scenario=" + scenario,
                ]
                with self.subTest(scenario=scenario):
                    try:
                        completed = subprocess.run(
                            command,
                            text=True,
                            capture_output=True,
                            check=False,
                            timeout=10,
                        )
                        stdout = completed.stdout
                        stderr = completed.stderr
                        self.assertEqual(completed.returncode, 0, stderr[-4000:])
                    except subprocess.TimeoutExpired as error:
                        # Some macOS Chrome builds keep the headless parent
                        # process alive after --dump-dom. The DOM marker remains
                        # authoritative because it is written only after every
                        # browser assertion has completed.
                        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
                        stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or "")
                    match = re.search(
                        r'<pre id="browser-test-result" data-status="([^"]+)">([^<]*)</pre>',
                        stdout,
                    )
                    self.assertIsNotNone(match, stdout[-4000:] + stderr[-2000:])
                    self.assertEqual(match.group(1), "passed", match.group(2))
                    self.assertEqual(match.group(2), "passed:" + scenario)


if __name__ == "__main__":
    unittest.main()
