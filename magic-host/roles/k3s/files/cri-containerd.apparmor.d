# SPDX-License-Identifier: Apache-2.0
# Copyright The docker Authors.
# Copyright The Moby Authors.
# Copyright The containerd Authors.
# Derived from k3s-io/containerd v2.3.4-k3s1.36, contrib/apparmor/template.go.
# Magic Stick modification: add only the exact stacked-label signal peer.
# See containerd-apparmor-LICENSE.txt beside the host loader for license/provenance.
# This is a compatibility backport, not a released upstream fix.
abi <abi/3.0>,
#include <tunables/global>

profile cri-containerd.apparmor.d flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,
  capability,
  file,
  umount,
  # Host and runtime managers may signal container processes, not vice versa.
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=cri-containerd.apparmor.d,
  # Exact label observed with Ubuntu AppArmor stacking; no wildcard or host grant.
  signal (send,receive) peer="cri-containerd.apparmor.d//&unconfined",

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,

  deny mount,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  # Keep the original ptrace policy; this backport adds no ptrace permissions.
  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d,
}
