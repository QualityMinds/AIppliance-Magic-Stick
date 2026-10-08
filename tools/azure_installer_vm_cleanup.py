# SPDX-License-Identifier: BUSL-1.1
"""Delete only expired, specifically tagged Magic Stick installer test groups."""

import argparse
from datetime import datetime, timezone
import json
import re
import subprocess


GROUP_NAME = re.compile(r"ms-installer-ci-[0-9]+-[0-9]+\Z")
PURPOSE = "magicstick-installer-vm-test"
SUBSCRIPTION_NAME = "qm-dev-vibecoding"


def expired_test_group(group, now):
    tags = group.get("tags") or {}
    if (not GROUP_NAME.fullmatch(group.get("name", ""))
            or group.get("location", "").lower() != "germanywestcentral"
            or tags.get("purpose") != PURPOSE):
        return False
    try:
        expires = datetime.strptime(tags["expiresAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return False
    return expires < now


def az(*args):
    return subprocess.run(["az", *args], check=True, text=True, capture_output=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subscription", required=True)
    parser.add_argument("--delete-expired", action="store_true")
    args = parser.parse_args()
    name = az("account", "show", "--subscription", args.subscription,
              "--query", "name", "--output", "tsv").strip()
    if name != SUBSCRIPTION_NAME:
        parser.error("Only qm-dev-vibecoding is permitted")
    groups = json.loads(az("group", "list", "--subscription", args.subscription, "--output", "json"))
    now = datetime.now(timezone.utc)
    expired = [group["name"] for group in groups if expired_test_group(group, now)]
    for group_name in expired:
        if not args.delete_expired:
            print(f"Would delete expired installer test group: {group_name}")
            continue
        print(f"Deleting expired installer test group: {group_name}", flush=True)
        az("group", "delete", "--subscription", args.subscription,
           "--name", group_name, "--yes", "--no-wait", "--output", "none")
        az("group", "wait", "--subscription", args.subscription,
           "--name", group_name, "--deleted", "--interval", "15",
           "--timeout", "600", "--output", "none")
    print(f"Expired matching groups: {len(expired)}")


if __name__ == "__main__":
    main()
