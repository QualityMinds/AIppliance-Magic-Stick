# Magic Stick licensing

Magic Stick Community is available under the [MIT License](LICENSE), including
commercial use. Explicitly marked Enterprise components have separate terms.
The Enterprise notice in this review is provisional, not a completed customer
agreement. Publishing this review does not approve a commercial release.

## Which terms apply?

| Files or components | Applicable terms |
|---|---|
| Existing Community code and documentation, unless a file explicitly states otherwise | [MIT License](LICENSE) |
| `enterprise/magicstick_enterprise/` files marked `LicenseRef-MagicStick-Enterprise` | [Enterprise licensing notice](enterprise/LICENSE) |
| License issuer/verifier, upload/storage/status infrastructure, shared API contracts, React UI, CLI/TUI and integration guards | MIT; these are Community infrastructure, not the paid business implementation |
| `enterprise/README.md` and this overview | MIT |
| Third-party dependencies, images, charts and model artifacts | Their respective upstream terms; see [Third-Party Notices](THIRD_PARTY_NOTICES.md) |

The root MIT license text is unchanged. This boundary does not withdraw or
replace rights in code already made available under MIT, and does not add an
Enterprise payment requirement to existing Community functionality. A call to
an optional Enterprise extension does not relicense the caller.

New Enterprise files must explicitly identify their applicable terms; the
current exception is not a blanket commercial relicensing of the repository.
Source visibility alone is not an unrestricted-use license. Do not describe a
combined Community/Enterprise distribution as entirely MIT-licensed.

## License document versus commercial agreement

The signed file uploaded in **License & Enterprise** contains technical
entitlements, validity dates and optional installation binding. It is not a
replacement for a commercial agreement and does not itself define the legal
rights to use Enterprise code. Uploading a file is not a purchase or acceptance
workflow. The final agreement must specify customer rights and applicable terms
separately; no price, renewal, support level or jurisdiction is implied here.

Before customer release, review the Enterprise notice and final customer terms
with qualified legal counsel and approve the package scope and notices.
The CI/default API image remains Community-only during that review. The
explicit local Enterprise build is used for technical validation; it is not a
general evaluation-license grant.

## Distribution and attribution

- Preserve the applicable copyright and license notices in source and packages.
- Enterprise file headers use `SPDX-License-Identifier: LicenseRef-MagicStick-Enterprise`
  and refer to the scoped [notice](enterprise/LICENSE).
- Combined API images include the MIT text, this overview and the Enterprise
  notice; Community images contain no Enterprise business implementation.
- The React dashboard bundles the same source texts for offline inspection and
  download. Displaying an Enterprise notice does not mean the extension is installed.
- Upstream license obligations remain separate. Build labels must describe the
  included code; an Enterprise image must not advertise only `MIT`.

For technical activation, persistence and recovery, see
[offline license management](docs/licensing.md). For the first optional business
capability, see [targeted instance access](docs/instance-sharing.md).
