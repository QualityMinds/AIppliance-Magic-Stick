# SPDX-License-Identifier: BUSL-1.1
"""Collect original license files from installed product distributions."""
import argparse
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
