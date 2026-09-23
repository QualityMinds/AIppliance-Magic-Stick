#!/usr/bin/env python3
"""Validate the public release trust bundle. Never generates or reads a signing key."""
import argparse
import hashlib
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from licensing import LicenseError, official_public_keys, strict_json


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", help="Public trusted-keys.json, or - for stdin")
    parser.add_argument("--manifest", action="store_true", help="Read the official Kubernetes ConfigMap instead of JSON")
    args = parser.parse_args(argv)
    if args.document == "-":
        content = sys.stdin.read(65537)
    else:
        with Path(args.document).open(encoding="utf-8") as stream:
            content = stream.read(65537)
    if len(content.encode("utf-8")) > 65536:
        raise ValueError("Public trust bundle exceeds 64 KiB.")
    if args.manifest:
        import yaml
        try:
            manifest = yaml.safe_load(content)
        except yaml.YAMLError as error:
            raise ValueError("Official trust manifest is invalid YAML.") from error
        if (not isinstance(manifest, dict) or manifest.get("kind") != "ConfigMap"
                or not isinstance(manifest.get("metadata"), dict)
                or manifest["metadata"].get("name") != "magicstick-license-official-trust"
                or not isinstance(manifest.get("data"), dict)):
            raise ValueError("Expected the official license trust ConfigMap.")
        content = manifest.get("data", {}).get("trusted-keys.json", "")
        if not isinstance(content, str):
            raise ValueError("Official trust manifest must contain a JSON string.")
    keys, retired = official_public_keys(strict_json(content))
    if not keys:
        raise ValueError("Official issuer public key is missing; this build is not ready for license activation.")
    for kid, key in sorted(keys.items()):
        der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        print(f"{kid}: SHA256 {hashlib.sha256(der).hexdigest()}")
    print(f"Public trust bundle verified: {len(keys)} active keys, {len(retired)} retired IDs.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, LicenseError) as error:
        print(f"Public trust check failed: {error}", file=sys.stderr)
        sys.exit(1)
