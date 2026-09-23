# Hardware and network requirements

## Before choosing an installation

Use a dedicated computer or VM. A starting point for the platform is 4 CPU cores,
16 GiB RAM and 100 GiB disk; this is not a model-sizing guarantee. Model weights,
runtime images, context buffers and application databases need additional capacity.

The USB installer targets x86-64 Ubuntu Server. Existing-host installation also
accepts supported ARM64 Ubuntu hosts, but every selected image and engine must
support that architecture. Refer to the [installer defaults](../../magic-installer/README.md)
and [compute targets](../reference/compute-targets.md) rather than assuming parity.

## GPU and memory

- A GPU is optional for the appliance; CPU models and external providers are alternatives.
- Check the [engine and hardware matrix](../reference/compatibility.md) before buying hardware.
- On unified-memory hardware, GPU and CPU may share physical RAM. Do not add
  every number in the dashboard as if it were an independent memory pool.
- Leave space for the OS, identity services, runtime images, temporary downloads
  and application data. Use a small supported model for the first test.

## Network and access

You need Internet access during installation for Ubuntu packages, images and charts,
and during model downloads. Keep the appliance and administration browser on a
trusted private network for initial setup. Ethernet is preferable for large downloads;
Wi-Fi requires a driver supported by the installer and your access point.

Do not expose the temporary setup port `9443` to the Internet. Cloud/VPN networks
often do not carry mDNS; use the private setup address printed by the installer.
Keep local console or independent administrative access when changing networking.

For an existing cluster, also check its storage class, LoadBalancer, permissions
and provider-specific GPU requirements in the [cluster installation guide](../installation/existing-kubernetes.md).
