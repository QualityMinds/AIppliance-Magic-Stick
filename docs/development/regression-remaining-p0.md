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
Experimental **FreeToken tests are currently disabled**, including FreeToken
cache and Mesh subtests. FreeToken itself remains available in the product.
Credentials, current boot/revision pins, small models and fixtures are prepared
automatically. **No repeated setup, approval forms or manual JSON.** Existing
models are stopped, not deleted. Independent tests continue after failures;
unproved cleanup blocks later live writes. Ctrl+C stops further tests.

Rebuild after changing runner code. Optional subset: `all --phases 2-4`.

The lock is renewed independently of browser/model waits. Browser actions have
short deadlines; cleanup has its own bounded window. After an interruption,
the next `all` automatically inspects and restores provably owned resources and
recorded module/sharing settings, then releases the expired lock. Keep the same
private directory. A running owner, missing journal or foreign revision remains
Blocked; the report gives the reason. Original failed results are never changed.

## Results

- **Passed:** the selected scenario was executed and verified.
- **Failed:** a product assertion, API, timeout or harness error failed.
- **Blocked:** a real prerequisite is absent, or execution cannot safely proceed.

Missing GPUs/runtimes, a real Mesh peer, test IdP, power controller or current CI
evidence blocks dependent cases only. The report states the reason and next action.
Current prerequisites and actions: `.regression/inputs/automatic-preparation.txt`.

If automatic preparation fails, reports show the reason and setup stage from
that attempt. Dependent live checks are Blocked; independent tests still run.

Open `summary.html` under `.regression/private/runs/reg-…/`; the console prints
the path. `all-summary.txt` gives the overview; JSON/JUnit support CI. Exit codes:
**0** passed, **1** failures, **2** blocked without failures. Never publish inputs
or raw private journals.

Reports distinguish executable scenarios from their case/variant/layer evidence
rows. A late Stop failure does not invalidate earlier successful inference or
logs; unreached Start checks are Blocked because of that failed prerequisite.
GPU Stop timeouts save a private `stop-<model>.json` showing whether the saved
intent, remaining Pods or generated route prevented completion.
Owning UI-suite failures retain bounded `component-failure.json` diagnostics
without raw assertion values, logs or secrets. Failed module/user postconditions
still run UID- and revision-bound cleanup; ambiguous ownership remains Blocked.

## CI

Use the same commands on a trusted runner with protected, persistent lab inputs;
never expose it to untrusted forks. First registration can use `setup --url …
--username … --password-file … --ca-file …`. No prompts occur during `all`.
The ordinary browser CI also runs the isolated module/user failure-cleanup
contracts without test-server access.

See the [catalog](regression-test-catalog.md) and [technical reference](regression-runner-reference.md)
for details. Installation tests and P1 are separate; implementation is not live acceptance.
