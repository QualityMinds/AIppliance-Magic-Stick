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
from licensing import (FEATURES, FORMAT, TOKEN_TYPE, LicenseError, LicenseService,
                       public_keys, strict_json, validate_claims, verify_document)


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
