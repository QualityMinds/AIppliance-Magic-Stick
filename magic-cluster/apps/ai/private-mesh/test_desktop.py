import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch
import test_support

from desktop_client import DesktopClient, bundle_files, client_handler, companion_self_test
from mesh_service import Identity, MeshError, MeshService, Store, canonical
from runtime import MeshRuntime, transport_process_options
from server import BoundedHTTPServer


class DesktopBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = DesktopClient(self.directory.name, '/unused/mesh-llm', '/unused/checksum')
        self.server = BoundedHTTPServer(('127.0.0.1', 0), client_handler(self.app, b'<script nonce="__NONCE__"></script>'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.app.service.store.db.close()
        self.directory.cleanup()

    def fetch(self, path, token=None, origin=None, body=None, bearer=None, host=None):
        client = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        headers = {'Content-Type': 'application/json'}
        if token is not None:
            headers['X-MagicStick-Session'] = token
        if origin:
            headers['Origin'] = origin
        if bearer is not None:
            headers['Authorization'] = 'Bearer ' + bearer
        if host is not None:
            headers['Host'] = host
        client.request('GET' if body is None else 'POST', path, None if body is None else json.dumps(body), headers)
        response = client.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        client.close()
        return result

    def test_html_never_discloses_session_credential(self):
        status, headers, body = self.fetch('/')
        self.assertEqual(status, 200)
        self.assertNotIn(self.app.token, json.dumps(headers))
        self.assertNotIn(self.app.token.encode(), body)
        self.assertNotIn(self.app.api_token.encode(), body)
        self.assertIn(self.app.nonce.encode(), body)
        self.assertEqual(self.fetch('/status', self.app.nonce)[0], 401)

    def test_connection_info_requires_ui_session_and_uses_actual_listener(self):
        self.assertEqual(self.fetch('/connection')[0], 401)
        self.assertEqual(self.fetch('/connection', bearer=self.app.api_token)[0], 403)
        status, headers, body = self.fetch('/connection', self.app.token)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        connection = json.loads(body)
        self.assertEqual(connection['baseUrl'], f'http://127.0.0.1:{self.server.server_port}/v1')
        self.assertEqual(connection['apiKey'], self.app.api_token)
        self.assertNotEqual(connection['apiKey'], self.app.token)
        self.assertFalse(connection['streaming'])
        self.assertNotIn(self.app.api_token.encode(), self.fetch('/status', self.app.token)[2])

    def test_inference_key_can_list_models_but_cannot_control_the_client(self):
        self.app.models = ['share/stick-a/example']
        status, _, body = self.fetch('/v1/models', bearer=self.app.api_token)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['data'][0]['id'], 'share/stick-a/example')
        for path in ['/leave', '/quit', '/join', '/relay', '/invite', '/share']:
            with self.subTest(path=path):
                self.assertEqual(self.fetch(path, bearer=self.app.api_token, body={})[0], 403)
        self.assertFalse(self.app.stop.is_set())
        self.assertEqual(self.fetch('/status', bearer=self.app.api_token)[0], 403)
        self.assertEqual(self.fetch('/v1/models', bearer='invalid-key')[0], 401)

    def test_inference_key_keeps_host_and_browser_origin_protection(self):
        self.assertEqual(self.fetch('/v1/models', bearer=self.app.api_token, origin='https://example.com')[0], 403)
        self.assertEqual(self.fetch('/v1/models', bearer=self.app.api_token, host='example.com')[0], 403)

    def test_inference_key_uses_chat_path_and_rejects_unavailable_models(self):
        name = 'share/stick-a/example'
        self.app.models = [name]
        roster = {'members': {'fixture': {'revoked': False, 'type': 'magic-stick', 'exports': {name: {}}}}}
        completion = {'choices': [{'message': {'role': 'assistant', 'content': 'Hello'}}]}
        with patch.object(self.app.service, 'activeRoster', return_value=roster), patch('desktop_client.json_request', return_value=completion) as upstream:
            status, _, body = self.fetch('/v1/chat/completions', bearer=self.app.api_token,
                                        body={'model': name, 'messages': [{'role': 'user', 'content': 'Hello'}], 'stream': False})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), completion)
            self.assertFalse(upstream.call_args.args[2]['stream'])
            self.assertNotIn(self.app.api_token, str(upstream.call_args))
            self.assertEqual(self.fetch('/v1/chat/completions', bearer=self.app.api_token, body={'model': 'unknown'})[0], 404)
            self.assertEqual(upstream.call_count, 1)

    def test_streaming_rejected_instead_of_returning_an_unexpected_response_format(self):
        with patch('desktop_client.json_request') as upstream:
            status, _, body = self.fetch('/v1/chat/completions', bearer=self.app.api_token, body={'stream': True})
            self.assertEqual(status, 400)
            self.assertIn('stream to false', json.loads(body)['error'])
            upstream.assert_not_called()

    def test_api_key_changes_on_new_application_launch(self):
        other = DesktopClient(Path(self.directory.name) / 'other', '/unused/mesh-llm', '/unused/checksum')
        try:
            self.assertNotEqual(self.app.api_token, other.api_token)
        finally:
            # Windows cannot remove an open SQLite database. addCleanup runs
            # after tearDown, which already deletes this test's directory.
            other.service.store.db.close()

    def test_launch_session_and_origin_are_both_checked(self):
        self.assertEqual(self.fetch('/status')[0], 401)
        self.assertEqual(self.fetch('/status', self.app.token)[0], 200)
        self.assertEqual(self.fetch('/status', self.app.token, 'https://example.com')[0], 403)

    def test_companion_cannot_manage_infrastructure(self):
        self.assertEqual(self.fetch('/invite', self.app.token, body={'type': 'magic-stick'})[0], 403)
        self.assertEqual(self.fetch('/share', self.app.token, body={'model': 'qwen'})[0], 403)

    def test_infrastructure_invite_rejected_before_enrollment(self):
        with patch.object(self.app.service, 'decodeInvite', return_value={'type': 'magic-stick'}), patch.object(self.app.service, 'joinMesh') as join:
            self.assertEqual(self.fetch('/join', self.app.token, body={'token': 'test'})[0], 403)
            join.assert_not_called()


class RuntimeLifecycleTests(unittest.TestCase):
    def test_new_bootstrap_hints_do_not_restart_a_healthy_client(self):
        with tempfile.TemporaryDirectory() as directory:
            service = MeshService(Store(':memory:'), lambda: {}, consume_only=True)
            authority = Identity().endpoint
            with service.store.change() as state:
                state['node'] = {'id': service.identity.endpoint, 'name': 'client-c', 'type': 'client'}
                state['mesh'] = {'id': 'fixture', 'authority': authority}
                state['roster'] = {'expiresAt': time.time() + 120, 'bootstrap': 'initial-token',
                                   'members': {service.identity.endpoint: {'name': 'client-c', 'type': 'client', 'revoked': False}}}
            binary = Path(directory) / 'binary'
            binary.write_bytes(b'test-only-binary')
            checksum = Path(directory) / 'checksum'
            checksum.write_text(hashlib.sha256(binary.read_bytes()).hexdigest())
            process = MagicMock()
            process.poll.return_value = None
            runtime = MeshRuntime(service, Path(directory) / 'runtime', '0' * 64)
            with patch.dict('os.environ', {'MESH_BINARY': str(binary), 'MESH_BINARY_CHECKSUM': str(checksum)}), patch('runtime.subprocess.Popen', return_value=process) as start:
                runtime.reconcile()
                with service.store.change() as state:
                    state['roster']['bootstrap'] = 'updated-address-hints'
                runtime.reconcile()
                self.assertEqual(start.call_count, 1)
                process.terminate.assert_not_called()
                env = start.call_args.kwargs['env']
                self.assertNotIn('LITELLM_MASTER_KEY', env)
                self.assertNotIn('MESH_ADMIN_TOKEN', env)
                self.assertNotIn('openai-endpoint', (Path(directory) / 'runtime/home/.mesh-llm/config.toml').read_text())
            service.store.db.close()


class NativeEnvironmentTests(unittest.TestCase):
    def test_windows_gets_required_os_bootstrap_but_no_application_secrets(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('runtime.sys.platform', 'win32'), \
                patch('runtime.subprocess.CREATE_NO_WINDOW', 0x08000000, create=True), \
                patch.dict(os.environ, {'SystemRoot': 'C:\\Windows', 'PATH': 'fixture-path',
                                       'LITELLM_MASTER_KEY': 'test-only', 'MESH_ADMIN_TOKEN': 'test-only',
                                       'HTTP_PROXY': 'test-only'}, clear=True):
            home = Path(directory) / 'home'
            options = transport_process_options(home)
            self.assertEqual(options['creationflags'], 0x08000000)
            self.assertEqual(options['env'], {'SystemRoot': 'C:\\Windows', 'WINDIR': 'C:\\Windows',
                             'PATH': 'fixture-path', 'HOME': str(home), 'USERPROFILE': str(home),
                             'TEMP': str(home / 'tmp'), 'TMP': str(home / 'tmp')})
            self.assertTrue((home / 'tmp').is_dir())

    def test_windows_missing_systemroot_is_a_clear_startup_error(self):
        with patch('runtime.sys.platform', 'win32'), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(MeshError, 'SystemRoot'):
                transport_process_options(Path('/unused'))

    def test_posix_does_not_inherit_windows_flags_or_user_config(self):
        with patch('runtime.sys.platform', 'linux'), patch.dict(os.environ, {'HOME': '/private-home', 'PATH': 'fixture-path'}, clear=True):
            self.assertEqual(transport_process_options('/isolated'),
                             {'env': {'HOME': '/isolated', 'PATH': 'fixture-path'}})


class FrozenLaunchCheckTests(unittest.TestCase):
    def make_bundle(self, root):
        binary = root / ('mesh-llm.exe' if os.name == 'nt' else 'mesh-llm')
        binary.write_bytes(b'fixture transport')
        (root / 'magicstick-mesh.sha256').write_text(hashlib.sha256(binary.read_bytes()).hexdigest() + '  ' + binary.name + '\n')
        (root / 'client.html').write_bytes(b'<h1>Private Mesh</h1><script nonce="__NONCE__"></script>')
        return binary

    def test_packaged_check_exercises_loopback_auth_and_shutdown_without_joining(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}):
            bundle = Path(directory)
            binary = self.make_bundle(bundle)
            with patch('desktop_client.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'mesh-llm 0.76.2\n')) as native, \
                    patch('desktop_client.webbrowser.open') as browser, \
                    patch('desktop_client.enrollment_exchange') as enroll, \
                    patch('runtime.subprocess.Popen') as transport:
                report = companion_self_test(bundle)
            self.assertEqual(report, {'version': 1, 'platform': sys.platform, 'launcherVerified': True,
                                     'transportVerified': True, 'loopbackAuthVerified': True, 'meshInferenceVerified': False})
            self.assertEqual(native.call_args.args[0], [str(binary), '--version'])
            self.assertFalse(Path(native.call_args.kwargs['env']['MESH_LLM_DATA_DIR']).parent.exists())
            self.assertFalse((bundle / 'client.db').exists())
            browser.assert_not_called()
            enroll.assert_not_called()
            transport.assert_not_called()

    def test_changed_transport_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            binary = self.make_bundle(bundle)
            binary.write_bytes(b'changed transport')
            with patch('desktop_client.subprocess.run') as native:
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    companion_self_test(bundle)
                native.assert_not_called()

    def test_missing_bundle_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                bundle_files(Path(directory))


if __name__ == '__main__':
    unittest.main()
