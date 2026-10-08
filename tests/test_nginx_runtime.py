# SPDX-License-Identifier: BUSL-1.1
"""Exercise the real pinned nginx binary inside the web Pods' resource budgets.

Run with MAGICSTICK_RUN_NGINX_CONTAINER_TESTS=1; this is enabled in public CI.
No appliance credentials, host ports or external network are used.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
import uuid

import yaml

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "magic-cluster/platform/identity"


@unittest.skipUnless(os.environ.get("MAGICSTICK_RUN_NGINX_CONTAINER_TESTS") == "1",
                     "explicit Docker runtime test; enabled in public CI")
class NginxRuntimeTests(unittest.TestCase):
    def command(self, *args, timeout=30):
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        return result.stdout

    def exercise(self, image, config, cpu, memory, port, path, expected, non_root=False):
        name = "magicstick-nginx-test-" + uuid.uuid4().hex[:12]
        image_check = subprocess.run(["docker", "image", "inspect", image],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if image_check.returncode != 0:
            self.command("pull", image, timeout=180)
        with tempfile.TemporaryDirectory(prefix="magicstick-nginx-", dir="/tmp") as directory:
            index = Path(directory) / "index.html"
            index.write_text("<html><body>Magic Stick nginx regression</body></html>\n")
            args = ["create", "--name", name, "--network", "none", "--cpus", cpu,
                    "--memory", memory, "--memory-swap", memory, "--pids-limit", "16",
                    "--cap-drop", "ALL", "--volume", str(config) + ":/etc/nginx/nginx.conf:ro",
                    "--volume", str(index.resolve()) + ":/usr/share/nginx/html/index.html:ro"]
            if non_root:
                args += ["--user", "101:101", "--read-only", "--tmpfs", "/tmp:rw,mode=1777",
                         "--add-host", "ai-appliance-dashboard-api.identity-system.svc.cluster.local:127.0.0.1"]
            else:
                for capability in ("CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"):
                    args += ["--cap-add", capability]
            container_id = None
            try:
                container_id = self.command(*args, image).strip()
                self.command("start", container_id)
                url = "http://127.0.0.1:" + str(port) + path
                deadline = time.monotonic() + 30
                while True:
                    probe = subprocess.run(["docker", "exec", name, "wget", "-q", "-O-", url],
                                           capture_output=True, text=True, timeout=10)
                    if probe.returncode == 0:
                        self.assertIn(expected, probe.stdout)
                        break
                    if time.monotonic() >= deadline:
                        self.fail("nginx did not become ready: " + self.command("logs", name)[-2000:])
                    time.sleep(0.2)
                self.command("exec", name, "sh", "-ec",
                             'for i in 1 2 3 4 5 6 7 8 9 10; do wget -q -O /dev/null "' + url + '"; done')
                processes = self.command("exec", name, "ps", "-o", "args")
                workers = [line for line in processes.splitlines() if line.strip().startswith("nginx: worker process")]
                self.assertEqual(len(workers), 1, processes)
                config_dump = self.command("exec", name, "nginx", "-T")
                self.assertEqual(re.findall(r"^\s*worker_processes\s+([^;]+);", config_dump, re.MULTILINE), ["1"])
                if non_root:
                    self.assertEqual(self.command("exec", name, "wget", "-q", "-O-",
                                                  "http://127.0.0.1:8080/").strip(), index.read_text().strip())
                events = dict(line.split() for line in self.command(
                    "exec", name, "cat", "/sys/fs/cgroup/memory.events").splitlines())
                self.assertEqual(events["oom"], "0")
                self.assertEqual(events["oom_kill"], "0")
                state = json.loads(self.command("inspect", name))[0]
                self.assertTrue(state["State"]["Running"])
                self.assertFalse(state["State"]["OOMKilled"])
                self.assertEqual(state["RestartCount"], 0)
            finally:
                if container_id:
                    cleanup = subprocess.run(["docker", "rm", "--force", container_id], capture_output=True,
                                             text=True, timeout=30)
                    self.assertEqual(cleanup.returncode, 0, cleanup.stderr)

    def test_pilot_runs_one_worker_under_64_mib(self):
        docs = list(yaml.safe_load_all((IDENTITY / "routes.yaml").read_text()))
        container = next(item for item in docs if item["kind"] == "Deployment" and
                         item["metadata"]["name"] == "auth-pilot")["spec"]["template"]["spec"]["containers"][0]
        limits = container["resources"]["limits"]
        self.exercise(container["image"], IDENTITY / "auth-pilot-nginx.conf",
                      str(int(limits["cpu"][:-1]) / 1000), limits["memory"].replace("Mi", "m"),
                      80, "/", "Magic Stick nginx regression")

    def test_dashboard_runs_one_non_root_worker_under_128_mib(self):
        dockerfile = (ROOT / "dashboard/apps/web/Dockerfile").read_text()
        image = re.search(r"^FROM (nginx:\S+)$", dockerfile, re.MULTILINE).group(1)
        deployment = yaml.safe_load((ROOT / "magic-cluster/apps/dashboard/deployment.yaml").read_text())
        limits = deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]
        self.exercise(image, ROOT / "dashboard/apps/web/nginx.conf",
                      str(int(limits["cpu"][:-1]) / 1000), limits["memory"].replace("Mi", "m"),
                      8080, "/healthz", "ok", non_root=True)


if __name__ == "__main__":
    unittest.main()
