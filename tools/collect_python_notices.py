# SPDX-License-Identifier: BUSL-1.1
"""Collect original license files from installed product distributions."""
import argparse
import hashlib
import importlib.metadata as metadata
from pathlib import Path
import re


def collect(names):
    result = ["Python third-party package notices. These do not license Magic Stick itself.\n"]
    for name in sorted(names, key=str.lower):
        dist = metadata.distribution(name)
        result.append(f"\n{dist.metadata['Name']}=={dist.version}\n" + "=" * 72 + "\n")
        found = []
        for file in dist.files or []:
            if re.match(r"(?i)^(licen[sc]e|copying|notice|authors)([.-]|$)", file.name):
                path = dist.locate_file(file)
                if path.is_file():
                    found.append((str(file), path.read_text(errors="strict")))
        if not found and name.lower().replace("_", "-") == "xds-protos" and dist.version == "1.76.0":
            # The upstream 1.76.0 xds-protos wheel omits LICENSE. Its official
            # gRPC release LICENSE is shipped byte-for-byte by grpcio 1.76.0.
            # Require that exact version and hash; all other missing notices
            # remain a hard error. Never infer a license from package metadata.
            grpc = metadata.distribution("grpcio")
            if grpc.version != "1.76.0":
                raise ValueError("xds-protos notice requires matching grpcio 1.76.0")
            candidates = [grpc.locate_file(file) for file in grpc.files or [] if file.name == "LICENSE"]
            expected = "590198e3f305f2c347fde64d637c65492bbef554db6c8364e149cd375e3797ee"
            verified = [path for path in candidates if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected]
            if len(verified) != 1:
                raise ValueError("xds-protos upstream notice unavailable or changed")
            found.append(("grpc/grpc v1.76.0 LICENSE (sha256 " + expected + ")", verified[0].read_text(errors="strict")))
        if not found:
            raise ValueError(f"No installed license files for {name}; inspect before distributing")
        for file, text in sorted(found):
            result.extend((file + "\n", text + "\n"))
    return "\n".join(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--all-installed", action="store_true", help="Collect runtime distributions, excluding packaging bootstrap tools")
    parser.add_argument("packages", nargs="*")
    args = parser.parse_args()
    packages = args.packages
    if args.all_installed:
        packages = [dist.metadata["Name"] for dist in metadata.distributions()
                    if dist.metadata["Name"].lower() not in {"pip", "setuptools", "wheel"}]
    if not packages:
        parser.error("Specify runtime packages or --all-installed")
    text = collect(packages)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text)
