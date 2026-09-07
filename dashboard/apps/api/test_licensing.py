import base64
import copy
import io
import json
import tempfile
import time
import unittest
import urllib.error
import uuid
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import license_issuer
import check_license_trust
from licensing import (FEATURES, FORMAT, TOKEN_TYPE, LicenseError, LicenseService,
                       combined_public_keys, official_public_keys, public_keys,
                       strict_json, validate_claims, verify_document)


class Store:
    def __init__(self):
        self.secret = None
        self.revision = 0
        self.fail_write = False

    def request(self, method, path, body=None):
        def fail(code):
            raise urllib.error.HTTPError(path, code, 'opaque storage failure', {}, None)
        if method == 'GET':
            if self.secret is None:
                fail(404)
            return copy.deepcopy(self.secret)
        if self.fail_write:
            fail(503)
        if method == 'POST' and self.secret is not None:
            fail(409)
        if method == 'PUT' and body['metadata']['resourceVersion'] != str(self.revision):
            fail(409)
        self.revision += 1
        self.secret = copy.deepcopy(body)
        self.secret['metadata']['resourceVersion'] = str(self.revision)
        self.secret['data'] = {k: base64.b64encode(v.encode()).decode() for k, v in self.secret.pop('stringData').items()}
        return copy.deepcopy(self.secret)


class LicenseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.key = Ed25519PrivateKey.generate()
        self.pem = self.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.trust = self.directory / 'trusted-keys.json'
        self.trust.write_text(json.dumps({'keys': {'test': self.pem}}))
        self.store = Store()
        self.service = LicenseService(self.store.request, 'test', self.trust)
        self.now = int(time.time())
        self.claims = {'version': 1, 'product': 'magicstick', 'issuer': 'magicstick', 'licenseId': 'test-license',
                       'customer': 'Example organization', 'issuedAt': self.now - 60, 'notBefore': self.now - 60,
                       'expiresAt': self.now + 3600, 'features': list(FEATURES)}

    def document(self, claims=None, key=None, headers=None):
        token = jwt.encode(claims or self.claims, key or self.key, algorithm='EdDSA', headers=headers or {'typ': TOKEN_TYPE, 'kid': 'test'})
        return json.dumps({'format': FORMAT, 'token': token})

    def verify(self, document, installation=''):
        return verify_document(document, public_keys({'keys': {'test': self.pem}}), installation, now=self.now)

    def test_valid_signature_and_no_business_features_enabled(self):
        self.assertTrue(self.verify(self.document())['valid'])
        preview = self.service.inspect(self.document())
        self.assertEqual(preview['current']['state'], 'missing')
        status = self.service.activate(self.document(), preview['current']['revision'])
        self.assertTrue(status['valid'])
        self.assertTrue(all(f['licensed'] for f in status['features']))
        self.assertTrue(all(not f['implemented'] and not f['available'] for f in status['features']))

    def test_state_survives_service_restart_and_export_is_exact(self):
        status = self.service.status()
        document = self.document()
        self.service.activate(document, status['revision'])
        restarted = LicenseService(self.store.request, 'test', self.trust)
        self.assertEqual(restarted.status()['installationId'], status['installationId'])
        self.assertTrue(restarted.status()['valid'])
        self.assertEqual(restarted.export()['content'], document)

    def test_invalid_upload_and_failed_storage_preserve_existing_license(self):
        self.service.activate(self.document(), self.service.status()['revision'])
        before = copy.deepcopy(self.store.secret)
        with self.assertRaises(LicenseError):
            self.service.activate(self.document(key=Ed25519PrivateKey.generate()), str(self.store.revision))
        self.assertEqual(before, self.store.secret)
        self.store.fail_write = True
        with self.assertRaisesRegex(LicenseError, 'storage is unavailable'):
            self.service.activate(self.document(), str(self.store.revision))
        self.assertEqual(before, self.store.secret)

    def test_stale_revision_does_not_overwrite(self):
        revision = self.service.status()['revision']
        self.service.activate(self.document(), revision)
        with self.assertRaises(LicenseError) as caught:
            self.service.activate(self.document(), revision)
        self.assertEqual(caught.exception.status, 409)

    def test_expiry_and_binding_are_rechecked_not_cached(self):
        installation = self.service.status()['installationId']
        document = self.document({**self.claims, 'installationId': installation})
        self.service.activate(document, self.service.status()['revision'])
        with patch('licensing.time.time', return_value=self.now + 3600):
            self.assertEqual(self.service.status()['state'], 'expired')
            self.assertTrue(all(not f['licensed'] for f in self.service.status()['features']))
        self.assertEqual(self.verify(document, str(uuid.uuid4()))['state'], 'wrong_installation')
        future = {**self.claims, 'notBefore': self.now + 100}
        self.assertEqual(self.verify(self.document(future))['state'], 'not_yet_valid')

    def test_trust_rotation_is_loaded_without_process_restart(self):
        self.service.activate(self.document(), self.service.status()['revision'])
        self.trust.write_text('{"keys":{}}')
        result = self.service.status()
        self.assertEqual(result['state'], 'untrusted_key')
        self.assertNotIn('claims', result)

    def official_store(self, document):
        path = self.directory / 'official-keys.json'
        path.write_text(json.dumps(document))
        self.service = LicenseService(self.store.request, 'test', self.trust, path)
        return path

    def test_official_keys_work_with_unchanged_empty_legacy_store(self):
        self.trust.write_text('{"keys":{}}')
        self.official_store({'keys': {'test': self.pem}, 'retiredKeyIds': []})
        status = self.service.status()
        self.assertEqual(status['trustedKeyIds'], ['test'])
        self.assertTrue(self.service.activate(self.document(), status['revision'])['valid'])
        self.assertEqual(self.trust.read_text(), '{"keys":{}}')

    def test_distinct_local_keys_remain_trusted_alongside_official_keys(self):
        other = Ed25519PrivateKey.generate()
        other_pem = other.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.official_store({'keys': {'official': other_pem}})
        self.assertEqual(self.service.status()['trustedKeyIds'], ['official', 'test'])
        self.assertTrue(self.service.inspect(self.document())['candidate']['valid'])
        issued = self.document(key=other, headers={'typ': TOKEN_TYPE, 'kid': 'official'})
        self.assertTrue(self.service.inspect(issued)['candidate']['valid'])

    def test_duplicate_identical_keys_are_safe_but_conflicts_fail_closed(self):
        official = self.official_store({'keys': {'test': self.pem}})
        self.assertTrue(self.service.inspect(self.document())['candidate']['valid'])
        other = Ed25519PrivateKey.generate()
        pem = other.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        official.write_text(json.dumps({'keys': {'test': pem}}))
        rejected = self.service.inspect(self.document())['candidate']
        self.assertEqual(rejected['state'], 'trust_unavailable')
        self.assertNotIn('claims', rejected)

    def test_official_retirement_cannot_be_undone_by_legacy_copy(self):
        path = self.official_store({'keys': {'test': self.pem}})
        self.service.activate(self.document(), self.service.status()['revision'])
        before = copy.deepcopy(self.store.secret)
        path.write_text(json.dumps({'keys': {}, 'retiredKeyIds': ['test']}))
        status = self.service.status()
        self.assertEqual(status['state'], 'untrusted_key')
        self.assertEqual(status['trustedKeyIds'], [])
        self.assertEqual(before, self.store.secret)
        self.assertIn('test', json.loads(self.trust.read_text())['keys'])

    def test_configured_official_file_must_exist_and_be_valid(self):
        path = self.official_store({'keys': {'test': self.pem}})
        for content in ('not JSON', '{"keys":{},"keys":{}}', '{"keys":{},"extra":true}'):
            path.write_text(content)
            with self.subTest(content=content):
                self.assertEqual(self.service.inspect(self.document())['candidate']['state'], 'trust_unavailable')
        path.unlink()
        self.assertEqual(self.service.inspect(self.document())['candidate']['state'], 'trust_unavailable')

    def test_official_path_is_configured_without_changing_existing_api_callers(self):
        path = self.official_store({'keys': {'test': self.pem}})
        self.trust.write_text('{"keys":{}}')
        with patch.dict('os.environ', {'LICENSE_OFFICIAL_TRUST_STORE': str(path)}):
            existing_api = LicenseService(self.store.request, 'test', self.trust)
            self.assertTrue(existing_api.inspect(self.document())['candidate']['valid'])

    def test_official_policy_rejects_bad_retirement_lists_and_private_keys(self):
        for retired in ('test', ['test', 'test'], [3], ['bad key'], ['test']):
            with self.subTest(retired=retired), self.assertRaises(LicenseError):
                official_public_keys({'keys': {'test': self.pem}, 'retiredKeyIds': retired})
        private = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        with self.assertRaises(LicenseError):
            official_public_keys({'keys': {'test': private}})

    def test_release_gate_rejects_empty_or_invalid_and_accepts_public_bundle(self):
        path = self.official_store({'keys': {'test': self.pem}, 'retiredKeyIds': []})
        with redirect_stdout(io.StringIO()) as output:
            check_license_trust.main([str(path)])
        self.assertIn('test: SHA256', output.getvalue())
        self.assertNotIn(self.pem, output.getvalue())
        path.write_text('{"keys":{}}')
        with self.assertRaisesRegex(ValueError, 'Official issuer public key is missing'):
            check_license_trust.main([str(path)])
        self.assertEqual(combined_public_keys({'keys': {}}), {})

    def test_untrusted_or_malformed_never_returns_claims(self):
        for document in ('garbage', '{"format":1,"format":2}', 'x' * 65537,
                         self.document(key=Ed25519PrivateKey.generate()),
                         self.document(headers={'typ': TOKEN_TYPE, 'kid': 'unknown'}),
                         self.document(headers={'typ': TOKEN_TYPE, 'kid': 'test', 'jku': 'https://example.com/key'})):
            with self.subTest(document_size=len(document)):
                result = self.service.inspect(document)['candidate']
                self.assertFalse(result['valid'])
                self.assertNotIn('claims', result)

    def test_unsigned_wrong_algorithm_and_tampering_rejected(self):
        unsigned = jwt.encode(self.claims, None, algorithm='none', headers={'typ': TOKEN_TYPE, 'kid': 'test'})
        hmac = jwt.encode(self.claims, b'x' * 64, algorithm='HS256', headers={'typ': TOKEN_TYPE, 'kid': 'test'})
        original = strict_json(self.document())['token'].split('.')
        original[1] = base64.urlsafe_b64encode(json.dumps({**self.claims, 'customer': 'Tampered'}).encode()).decode().rstrip('=')
        for token in (unsigned, hmac, '.'.join(original)):
            with self.assertRaises(LicenseError):
                self.verify(json.dumps({'format': FORMAT, 'token': token}))

    def test_strict_claim_contract(self):
        for changes in ({'version': True}, {'product': 'other'}, {'expiresAt': True}, {'features': ['unknown']},
                        {'features': ['multi-gpu', 'multi-gpu']}, {'installationId': 'bad'}, {'customer': 'line\nbreak'},
                        {'expiresAt': self.now - 100}, {'extra': 'field'}):
            with self.subTest(changes=changes), self.assertRaises(LicenseError):
                validate_claims({**self.claims, **changes})
        for value in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(ValueError):
                strict_json(value)

    def test_private_keys_are_never_trusted_as_public_keys(self):
        private = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        with self.assertRaises(LicenseError):
            public_keys({'keys': {'test': private}})

    def test_verification_performs_no_network_calls(self):
        with patch('socket.socket', side_effect=AssertionError('Offline verification must not use a socket')):
            self.assertTrue(self.verify(self.document())['valid'])

    def test_expired_future_and_wrong_binding_cannot_replace_valid_license(self):
        self.service.activate(self.document(), self.service.status()['revision'])
        before = copy.deepcopy(self.store.secret)
        for changes in ({'expiresAt': self.now - 1}, {'notBefore': self.now + 100}, {'installationId': str(uuid.uuid4())}):
            with self.subTest(changes=changes), self.assertRaises(LicenseError):
                self.service.activate(self.document({**self.claims, **changes}), str(self.store.revision))
            self.assertEqual(self.store.secret, before)

    def test_damaged_persisted_state_fails_closed(self):
        self.service.status()
        self.store.secret['data']['installationId'] = 'corrupt'
        with self.assertRaises(LicenseError) as caught:
            self.service.status()
        self.assertEqual(caught.exception.code, 'storage_invalid')

    def test_capability_checks_never_override_authorization_or_implementation(self):
        for feature in FEATURES:
            with self.assertRaises(LicenseError) as caught:
                self.service.require_capability(feature, authorized=False)
            self.assertEqual(caught.exception.status, 403)
        self.service.activate(self.document(), self.service.status()['revision'])
        with self.assertRaises(LicenseError) as caught:
            self.service.require_capability('multi-gpu', authorized=True)
        self.assertEqual(caught.exception.code, 'not_implemented')

    def test_issuer_encrypted_key_permissions_and_no_overwrite(self):
        password = self.directory / 'password'
        password.write_bytes(b'ephemeral-test-password')
        directory = self.directory / 'issuer'
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            license_issuer.main(['keygen', '--directory', str(directory), '--kid', 'test', '--password-file', str(password)])
            self.assertEqual((directory / 'signing-key.pem').stat().st_mode & 0o777, 0o600)
            claims = self.directory / 'claims.json'
            claims.write_text(json.dumps(self.claims))
            output = self.directory / 'license.json'
            args = ['issue', '--claims', str(claims), '--private-key', str(directory / 'signing-key.pem'), '--kid', 'test', '--output', str(output), '--password-file', str(password)]
            license_issuer.main(args)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertTrue(verify_document(output.read_text(), public_keys(strict_json((directory / 'trusted-keys.json').read_text())), '')['valid'])
            with self.assertRaises(FileExistsError):
                license_issuer.main(args)


if __name__ == '__main__':
    unittest.main()
