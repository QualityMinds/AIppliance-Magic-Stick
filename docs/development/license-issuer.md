# License issuer and trust

## Issuer and trust

Keep private keys, passwords, customer requests and issued files outside source
control and customer images. Use a controlled signing workstation:

```bash
python3 -m venv /path/to/private/issuer-venv
/path/to/private/issuer-venv/bin/pip install -r dashboard/apps/api/requirements.txt
/path/to/private/issuer-venv/bin/python dashboard/apps/api/license_issuer.py keygen \
  --directory /path/to/private/issuer-key \
  --kid example-issuer \
  --password-file /path/to/private/key-password

/path/to/private/issuer-venv/bin/python dashboard/apps/api/license_issuer.py issue \
  --claims /path/to/private/request.json \
  --private-key /path/to/private/issuer-key/signing-key.pem \
  --kid example-issuer \
  --password-file /path/to/private/key-password \
  --output /path/to/private/license.json
```

Directories are 0700 and key/license files 0600; existing files are never
overwritten. Omitting password-file emits a warning and leaves the private key
unencrypted. File permissions alone are not a backup or key-management policy.

Official installations ship only public keys in
`identity-system/magicstick-license-official-trust`. The bundled key ID is
`issuer-2026`; its DER SubjectPublicKeyInfo SHA-256 fingerprint is
`93f4bd3b664fea576fdd0b32ad9be44525b5a98207885b6cc251919ee1878182`.
Release verification:

```bash
python3 dashboard/apps/api/check_license_trust.py --manifest \
  magic-cluster/apps/dashboard/license-official-trust.yaml
```

The release-owned ConfigMap is mounted read-only using
`LICENSE_OFFICIAL_TRUST_STORE`. Optional locally administered public keys live
in `magicstick-license-trust` (`LICENSE_TRUST_STORE`). The API cannot mutate
either store. Equal key IDs must identify equal keys; conflicts fail closed.
The official bundle's `retiredKeyIds` overrides local copies of retired keys.

Rotation: publish new public keys alongside active keys, issue replacements,
then retire superseded key IDs in a reviewed release. Keep retirement IDs in
subsequent bundles. Offline appliances must receive the bundle update; there is
no instantaneous central revocation. Every status/activation/capability read
verifies fresh state, without positive entitlement caching.

## Release

BSL's version-specific Change Date is three calendar years after first public
distribution. Set the explicit dates in LICENSE-RELEASE.json before publishing
each version and ship that record with source and images. Never reset the date
by rebuilding or redistributing the same version. See the
[dependency and release audit](license-audit.md); legal review and artifact
obligations are distinct from a successful signature or test run.
