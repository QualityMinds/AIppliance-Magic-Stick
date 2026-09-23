# Storage troubleshooting

## Storage

```bash
kubectl get pvc -A
kubectl -n ai get pvc
```

Storage sizes in the public template default to small values. Private
deployments should patch or substitute production sizes before relying on the
appliance for persistent data.
