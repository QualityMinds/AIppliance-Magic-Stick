<a id="documentation"></a>

# Magic Stick documentation

Install and manage a local AI appliance without learning Kubernetes first.
Choose your starting point; technical details are kept separate from everyday tasks.

<a id="reading-path"></a>

| I want to… | Start here |
|---|---|
| Understand Magic Stick and choose hardware | [Get started](get-started/README.md) |
| Install on a PC, VM or Kubernetes cluster | [Choose an installation path](installation/README.md) |
| Run a model or open an application | [User guide](user-guide/README.md) |
| Manage users, GPUs, networking or updates | [Administration](administration/README.md) |
| Understand how the appliance works | [Concepts](concepts/README.md) |
| Look up a field, command or compatibility rule | [Reference](reference/README.md) |
| Build, extend or release Magic Stick | [Development](development/README.md) |

The [published handbook](https://qualityminds.github.io/AIppliance-Magic-Stick/handbook/)
is generated from these same Markdown files. The [marketing website](index.html)
introduces the product; it is not a second copy of this handbook.

## Reading conventions

- Start with a task guide. Follow its technical links only when you need them.
- UI labels match the English dashboard. Replace example values before use.
- A feature marked experimental is available for evaluation, not certified for
  every model, GPU or deployment.
- Local tests, upstream support and a successful physical-appliance test are
  different forms of evidence. Dated reports state their scope explicitly.
- Do not post passwords, API keys, setup claims, kubeconfigs or private logs in issues.

For project policies, see [support](../SUPPORT.md), [security](../SECURITY.md),
[licensing](../LICENSING.md), [release notes](../CHANGELOG.md) and [roadmap](../ROADMAP.md).

<a id="quick-commands"></a>

## Contributor checks

Build/render commands live in [development checks](development/testing.md).
Before publication, follow the [release checklist](development/release-checklist.md).
