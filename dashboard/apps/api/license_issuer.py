#!/usr/bin/env python3
"""Offline license issuer. This program is not copied into the customer image."""
import argparse
import json
import os
import sys
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from licensing import FORMAT, TOKEN_TYPE, IDENTIFIER, validate_claims, strict_json, verify_document, LicenseError


def write_new(path, content, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    gen = subs.add_parser("keygen", help="Create a private signing key and public trust store in a new directory")
    gen.add_argument("--directory", required=True)
    gen.add_argument("--kid", required=True)
    gen.add_argument("--password-file", help="Encrypt the private key with a password read from this file")
    sign = subs.add_parser("issue", help="Sign a claims JSON file; never prints the private key")
    sign.add_argument("--claims", required=True)
    sign.add_argument("--private-key", required=True)
    sign.add_argument("--kid", required=True)
    sign.add_argument("--output", required=True)
    sign.add_argument("--password-file")
    args = parser.parse_args(argv)
    if not IDENTIFIER.fullmatch(args.kid):
        parser.error("Invalid key ID.")
    password = Path(args.password_file).read_bytes().rstrip(b"\r\n") if args.password_file else None
    if password == b"":
        parser.error("Password file is empty.")
    if args.command == "keygen":
        key = Ed25519PrivateKey.generate()
        directory = Path(args.directory)
        directory.mkdir(mode=0o700, exist_ok=False)
        encryption = serialization.BestAvailableEncryption(password) if password else serialization.NoEncryption()
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, encryption)
        write_new(directory / "signing-key.pem", pem.decode("ascii"))
        public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")
        write_new(directory / "trusted-keys.json", json.dumps({"keys": {args.kid: public}}, indent=2) + "\n")
        print("Created signing-key.pem (private) and trusted-keys.json (public). Back up the key securely; distribute only the public trust store.")
        if not password:
            print("Warning: private key is protected by file permissions only; use --password-file for encrypted key storage.", file=sys.stderr)
        return
    claims = validate_claims(strict_json(Path(args.claims).read_text(encoding="utf-8")))
    key = serialization.load_pem_private_key(Path(args.private_key).read_bytes(), password=password)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("An Ed25519 private key is required.")
    token = jwt.encode(claims, key, algorithm="EdDSA", headers={"typ": TOKEN_TYPE, "kid": args.kid})
    document = json.dumps({"format": FORMAT, "token": token}, indent=2) + "\n"
    verified = verify_document(document, {args.kid: key.public_key()}, claims.get("installationId", ""))
    if not verified["valid"]:
        raise ValueError("Only currently valid licenses can be issued.")
    write_new(args.output, document)
    print("Signed license written. Keep customer license files out of source control.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, LicenseError):
        print("License issuance failed. Check input paths, claims, key type and password; existing files are never overwritten.", file=sys.stderr)
        sys.exit(1)
