# v1.0.0 installer delivery — 9 November 2026

The [v1.0.0 product release](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/v1.0.0)
now links a separately published, immutable
[fixed-version AMD64 installer](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/installer-v1.0.0-237a730d907b84d0eaa7cf3155a4950ca2e7c1a4506c247e7accba6d36fb27f7).
This records public delivery and media integrity, not a new installation result.

- Product source: `8e244d1c3d99350fa5b8f96a9ac7b254924072d6`.
- Annotated product tag object: `d6e2a672ea1da4002f93f75a333c788f0d223ab4`.
- Public product manifest SHA-256: `3ba93cc2c2c0d4a761f52b9709f7cdeba7e012bc2fe4ef9ecee7f8bb841bc084`.
- Installer source: the same exact product commit, not a later main revision.
- [Installer workflow](https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/42611852061),
  attempt 1: build and publish successful. It was dispatched once on main with
  the explicit already-published `product_version=v1.0.0`.
- Image: `magicstick-installer-v1.0.0-amd64-reduced-237a730d907b84d0.img`,
  2,019,033,088 bytes. Public full-image download SHA-256:
  `9aa886fb7632d50060ff52b400e3fb3bfea15dd334f5ef63a7467f9888eab993`.
- Public build metadata, checksum and evidence downloads were checked against
  their published hashes/sizes. The media manifest binds the same version,
  commit, annotated tag, product-manifest hash and original license record.
- BIOS/UEFI entries, signed reduced package pool and public bootstrap settings
  are covered by the build's media checks. No password, private bootstrap token
  or preconfigured SSH access is embedded.

The product page's editable body received the verified download links and was
read back. Its six original locked assets, original notes asset and immutable
product tag were not replaced. First public distribution remains **7 November
2026**, with MIT Change Date **7 November 2029**; packaging does not restart it.
Runtime container pins remain the already qualified v1.0.0 set. No new credential,
appliance update, USB write, VM installation or physical GPU/Wi-Fi acceptance was
performed. Open advisory license/artifact reviews are not approved by this record.

Use the [USB guide](../../installation/bare-metal.md) for downloading, checking
and safely writing the image. Future automatic exact-tag delivery is described
separately in [the release procedure](../releases.md); that source change does
not move or rebuild this published v1.0.0 baseline.
