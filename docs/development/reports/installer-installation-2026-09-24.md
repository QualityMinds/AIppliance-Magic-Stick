---
search:
  exclude: true
---

# Online installer: successful installation · 2026-09-24

## Result

On 24 September 2026, the project owner confirmed that installation with the
online installer succeeded and that the image can be used. This is a manual,
owner-reported installation result, not a new CI or agent-run hardware test.

The prebuilt online image remains the standard route in the
[USB installation guide](../../installation/bare-metal.md). No rebuild is needed
to record this result. Local image-building scripts remain developer tools.

## Download associated with this workflow

- [Published main-channel installer and checksums](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/installer-main-ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89).
- Build source: `7adea7a81f5a5cea1cd75a056eadc96d7a867ffa`.
- Recipe fingerprint: `ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89`.
- Published image SHA256: `b03edf5aa58600fa740d66a0c85efb6488058b8e9adc20c10a57ccd047f37636`.
- Ubuntu Server 26.04.1 AMD64; no offline package pool; Internet access required.

The confirmation did not include the checksum of the image actually written to
USB, hardware details or installation logs. The identity above describes the
published download, not a separately verified hash of the installed media.

## Scope and retained evidence

The successful installation supersedes the previously open manual-installation
result for this online-installer workflow. It does not certify every hardware
combination, GPU driver, operator or inference engine. Those checks remain separate.

Keep the original image, checksum, build manifest and evidence archive unchanged.
Their `physicalInstallation: false` / `installationTested: false` values describe
what CI had verified at build time. This dated report adds the later manual result;
it does not retroactively turn a CI integrity check into a physical test.

The existing GitHub prerelease classification distinguishes installer-channel
downloads from versioned product releases; it is not a statement that the reported
installation failed. Future image recipes need their own installation result.
