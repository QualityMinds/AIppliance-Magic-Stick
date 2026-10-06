# Run regression tests

Use a **dedicated, disposable test Magic Stick**. Full runs may stop models,
change settings, replace test licenses, clear model caches and reboot the server.
Run Docker on your Mac or a separate runner, not on the appliance it reboots.

## Once

From the repository root, with Docker running:

```bash
bash tools/regression.sh build
bash tools/regression.sh setup
```

Enter the dashboard URL and test administrator credentials. Supply the trusted
Appliance CA PEM only if needed. Setup discovers endpoints and creates scoped
Kubernetes access. Registration binds tests to this Appliance and its Node IDs;
`all` never adopts a replacement installation.

Interrupted setup resumes for that same registered server; no new questionnaire
or manual kubeconfig is needed.

## Every run

```bash
bash tools/regression.sh all
```

Every implemented Phase 0–8 P0 test runs or reports its missing prerequisite.
Credentials, current boot/revision pins, small models and fixtures are prepared
automatically. **No repeated setup, approval forms or manual JSON.** Existing
models are stopped, not deleted. Independent tests continue after failures;
unproved cleanup blocks later live writes. Ctrl+C stops further tests.

Rebuild after changing runner code. Optional subset: `all --phases 2-4`.

## Results

- **Passed:** the selected scenario was executed and verified.
- **Failed:** a product assertion, API, timeout or harness error failed.
- **Blocked:** a real prerequisite is absent, or execution cannot safely proceed.

Missing GPUs/runtimes, a real Mesh peer, test IdP, power controller or current CI
evidence blocks dependent cases only. The report states the reason and next action.
Current prerequisites and actions: `.regression/inputs/automatic-preparation.txt`.

Open `summary.html` under `.regression/private/runs/reg-…/`; the console prints
the path. `all-summary.txt` gives the overview; JSON/JUnit support CI. Exit codes:
**0** passed, **1** failures, **2** blocked without failures. Never publish inputs
or raw private journals.

## CI

Use the same commands on a trusted runner with protected, persistent lab inputs;
never expose it to untrusted forks. First registration can use `setup --url …
--username … --password-file … --ca-file …`. No prompts occur during `all`.

See the [catalog](regression-test-catalog.md) and [technical reference](regression-runner-reference.md)
for details. Installation tests and P1 are separate; implementation is not live acceptance.
