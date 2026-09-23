# Host, Kubernetes and Flux checks

## Host Checks

On the appliance host:

```bash
sudo systemctl status k3s
sudo journalctl -u k3s -n 200 --no-pager
sudo /usr/local/sbin/ai-appliance-converge
```

Check the host metadata that drives the converge runner:

```bash
sudo sed -n '1,160p' /etc/default/ai-appliance-repo
```

Do not paste secret values from that file into issues or public logs.

## Kubernetes Checks

With host-local K3s:

```bash
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get namespaces
sudo k3s kubectl -A get pods
```

With any configured kubeconfig:

```bash
kubectl get nodes -o wide
kubectl -A get pods
```

## Flux Checks

```bash
kubectl -n flux-system get gitrepositories
kubectl -n flux-system get kustomizations
kubectl -n flux-system get helmreleases
```

Inspect a failing reconciliation:

```bash
kubectl -n flux-system describe kustomization flux-system
kubectl -n flux-system describe kustomization magicstick-operator
kubectl -n ai-system get moduleactivations,appinstances
```

Trigger reconciliation after pushing a fix:

```bash
flux -n flux-system reconcile source git flux-system
flux -n flux-system reconcile kustomization flux-system --with-source
flux -n flux-system reconcile kustomization magicstick-operator --with-source
```

If the Flux CLI is not available locally, annotate the resource:

```bash
kubectl -n flux-system annotate gitrepository flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
kubectl -n flux-system annotate kustomization magicstick-operator \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
```
