# Installation in einem bestehenden Kubernetes-Cluster

Dieser Weg installiert die Kubernetes-Komponenten von Magic Stick in einem
vorhandenen Cluster. Er richtet **kein** Ubuntu, K3s, Host-mDNS, systemd-Timer
oder lokales Konsolenkommando ein. Er richtet sich deshalb an erfahrene
Kubernetes-Administratoren.

## Voraussetzungen

Du benötigst:

- einen funktionierenden Cluster und eine `cluster-admin`-Kubeconfig;
- `kubectl`, `helm` und die [Flux CLI](https://fluxcd.io/flux/installation/);
- unter Linux oder macOS zusätzlich Bash und Python 3, unter Windows
  PowerShell 7;
- eine Standard-StorageClass für persistente Volumes;
- eine LoadBalancer-Implementierung, die Envoy eine erreichbare private Adresse
  zuweisen kann;
- freie beziehungsweise bewusst zugewiesene Listener auf `443` und für das
  temporäre Setup auf `9443`;
- eine Netzwerkverbindung vom Administrator-Rechner zur privaten
  LoadBalancer-Adresse.

Magic Stick bringt Envoy Gateway mit. Ein bereits vorhandener Ingress- oder
Gateway-Controller darf weiterlaufen, solange er nicht dieselbe Adresse oder
dieselben Ports belegt. Entferne keinen gemeinsam genutzten Controller nur für
diese Installation; stelle stattdessen eine eigene LoadBalancer-Adresse bereit.

> Diese Anleitung ist für eine **neue Magic-Stick-Installation** in einem
> bestehenden Cluster. Sie ist kein Factory-Reset für eine bereits eingerichtete
> Installation.

## Empfohlener Weg: ein Installationsskript

Das Skript prüft zuerst Kontext, API-Erreichbarkeit, `cluster-admin`, eine
Standard-StorageClass und bestehende Magic-Stick- beziehungsweise
`flux-system`-Ressourcen. Es zeigt den API-Server vor der Bestätigung an und
überschreibt weder eine bestehende Appliance noch einen fremden Flux-Quellbaum.

Mit Bash:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/deploy-on-k8s.sh \
  -o /tmp/deploy-on-k8s.sh

less /tmp/deploy-on-k8s.sh
bash /tmp/deploy-on-k8s.sh \
  --context "$(kubectl config current-context)" \
  --preflight-only
bash /tmp/deploy-on-k8s.sh \
  --context "$(kubectl config current-context)"
```

Mit PowerShell 7:

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/deploy-on-k8s.ps1 `
  -OutFile $env:TEMP\deploy-on-k8s.ps1

Get-Content $env:TEMP\deploy-on-k8s.ps1
pwsh $env:TEMP\deploy-on-k8s.ps1 `
  -Context (kubectl config current-context) `
  -PreflightOnly
pwsh $env:TEMP\deploy-on-k8s.ps1 `
  -Context (kubectl config current-context)
```

Für reproduzierbare Installationen gibst du zusätzlich einen Release-Tag an:

```bash
bash /tmp/deploy-on-k8s.sh --context <context> --ref <release-tag>
```

```powershell
pwsh $env:TEMP\deploy-on-k8s.ps1 -Context <context> -Ref <release-tag>
```

Nach dem Flux-Abgleich erzeugt das Skript den achtstelligen Einrichtungscode,
gibt ihn genau einmal aus und speichert in Kubernetes nur seinen SHA-256-Hash.
Die Option `--yes` beziehungsweise `-Yes` ist ausschließlich für bereits
geprüfte, nicht interaktive Automatisierung vorgesehen.

Wird die Installation technisch unterbrochen, bleibt ausschließlich ein nicht
sensibler Status-`ConfigMap` zurück. Starte denselben Befehl mit denselben
Repository- und Versionsoptionen erneut; der Wrapper setzt den Bootstrap mit
derselben Installations-ID fort. Nach erfolgreicher Initialisierung wird dieser
Status automatisch entfernt.

## Manueller Fallback

Die folgenden Schritte dokumentieren den gleichen Ablauf einzeln. Sie sind für
Diagnose und Plattformen gedacht, auf denen der Wrapper nicht eingesetzt
werden kann.

### 1. Cluster prüfen

```bash
kubectl cluster-info
kubectl auth can-i '*' '*' --all-namespaces
kubectl get storageclass
kubectl get service --all-namespaces
```

Prüfe vor allem, ob bereits ein Dienst die gewünschte externe Adresse und Port
`443` verwendet.

### 2. Gateway- und Envoy-CRDs installieren

Envoy Gateway verwendet standardisierte Gateway-API-Ressourcen und eigene
Erweiterungen wie `SecurityPolicy` und `EnvoyProxy`. Magic Stick überspringt die
CRD-Installation im Helm-Release absichtlich, damit bereits vorhandene CRDs
nicht ungefragt von Helm übernommen oder ersetzt werden.

Prüfe zuerst:

```bash
kubectl get crd gateways.gateway.networking.k8s.io
kubectl get crd httproutes.gateway.networking.k8s.io
kubectl get crd envoyproxies.gateway.envoyproxy.io
kubectl get crd securitypolicies.gateway.envoyproxy.io
```

Wenn noch keine dieser CRDs vorhanden ist, installiere das zum Repository
passende CRD-Paket aus dem gepinnten Envoy-Gateway-Chart:

```bash
helm show crds oci://docker.io/envoyproxy/gateway-helm \
  --version v1.8.2 | kubectl apply --server-side -f -
```

Wenn dein Cluster die Standard-Gateway-API bereits selbst verwaltet, verwende
denselben serverseitigen Apply ohne `--force-conflicts`:

```bash
helm show crds oci://docker.io/envoyproxy/gateway-helm \
  --version v1.8.2 | kubectl apply \
  --server-side \
  --field-manager=magicstick-installer \
  -f -
```

Bei einer inkompatiblen oder anders verwalteten CRD stoppt Kubernetes mit
einem Feldkonflikt, statt die vorhandene Eigentümerschaft zu erzwingen. Kläre
diesen Konflikt mit dem Plattformverantwortlichen; verwende hier nicht
`--force-conflicts`.

Ändere die Version nicht unabhängig vom Repository. Sie muss zur Version in
`magic-cluster/platform/gateway/envoy-gateway/oci-repository.yaml` passen.

### 3. Flux installieren

```bash
flux check --pre
flux install
```

Lege die öffentlichen Standardwerte an. Passe die Beispiel-Domain bei Bedarf
an; den endgültigen Namen kannst du im First-Run-Setup setzen:

```bash
kubectl -n flux-system create configmap ai-appliance-settings \
  --from-literal=AI_APPLIANCE_DOMAIN=magicstick.example.com \
  --from-literal=AI_APPLIANCE_DASHBOARD_HOST=magicstick.example.com \
  --from-literal=AI_APPLIANCE_MDNS_DOMAIN=magicstick.local \
  --from-literal=AI_APPLIANCE_MDNS_NAME=magicstick \
  --from-literal=AI_APPLIANCE_DASHBOARD_MDNS_NAME=magicstick \
  --from-literal=AI_APPLIANCE_ENVOY_CRDS_POLICY=Skip \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 4. Öffentliche Magic-Stick-Quelle synchronisieren

```bash
flux create source git flux-system \
  --url=https://github.com/QualityMinds/AIppliance-Magic-Stick.git \
  --branch=main \
  --interval=1m \
  --export | kubectl apply -f -

flux create kustomization flux-system \
  --source=GitRepository/flux-system \
  --path=./magic-cluster/flux/entrypoints/single-node \
  --prune=true \
  --interval=10m \
  --wait=true \
  --timeout=15m \
  --export | kubectl apply -f -
```

Starte die erste Synchronisation und beobachte den Zustand:

```bash
flux reconcile source git flux-system --timeout=5m
flux reconcile kustomization flux-system --with-source --timeout=15m
flux get kustomizations
kubectl get pods --all-namespaces
```

Warte, bis insbesondere `infrastructure-basis`, `envoy-gateway` und
`identity-pilot` bereit sind.

### 5. Optional: Kubernetes-Zugriff über Magic-Stick-SSO aktivieren

Flux installiert den Keycloak-Client, die drei Zugriffsgruppen und die
Kubernetes-RBAC-Bindings. Ein vorhandener oder verwalteter Cluster ändert seine
API-Server-Konfiguration jedoch absichtlich nicht aus einem Workload heraus.
Dieser Schritt muss deshalb durch den Plattformadministrator erfolgen. Ohne ihn
bleibt nur der Kubeconfig-Download im Dashboard deaktiviert; alle anderen
Magic-Stick-Funktionen arbeiten weiter.

Voraussetzungen:

- `https://id.<mdns-domain>/realms/magicstick` ist vom Control Plane und vom
  Administrator-Rechner erreichbar;
- das lokale Identity-CA-Zertifikat ist als vertrauenswürdige OIDC-CA
  hinterlegt;
- der Kubernetes-Endpunkt ist vom Administrator-Rechner erreichbar und sein
  Zertifikat passt zum veröffentlichten Endpunkt;
- dein Kubernetes-Anbieter unterstützt die entsprechenden OIDC-API-Server-
  Optionen. Bei verwalteten Diensten verwendest du ausschließlich den dafür
  vorgesehenen Provider-Mechanismus.

Konfiguriere den API Server äquivalent zu:

```text
--oidc-issuer-url=https://id.<mdns-domain>/realms/magicstick
--oidc-client-id=magicstick-kubernetes
--oidc-username-claim=preferred_username
--oidc-username-prefix=oidc:
--oidc-groups-claim=groups
--oidc-groups-prefix=oidc:
--oidc-ca-file=<path-to-public-identity-ca>
```

Das CA-Zertifikat ist öffentlich; lies ausschließlich `tls.crt`, niemals
`tls.key`:

```bash
kubectl -n identity-system get secret identity-pilot-ca \
  -o jsonpath='{.data.tls\.crt}' | openssl base64 -d -A > identity-pilot-ca.crt

curl --fail --cacert identity-pilot-ca.crt \
  https://id.magicstick.local/realms/magicstick/.well-known/openid-configuration
```

Erst nachdem ein Neustart beziehungsweise Rollout des API Servers erfolgreich
war und seine Readiness geprüft wurde, veröffentlichst du die nicht sensible
Bestätigung für das Dashboard. Ersetze die beiden Endpunkte durch deine
effektiven Werte:

```bash
KUBERNETES_API_SERVER='https://kubernetes-api.example.com:6443'
OIDC_ISSUER='https://id.magicstick.local/realms/magicstick'

kubectl -n identity-system create configmap magicstick-kubernetes-access-info \
  --from-literal=enabled=true \
  --from-literal="issuer-url=${OIDC_ISSUER}" \
  --from-literal=client-id=magicstick-kubernetes \
  --from-literal="api-server=${KUBERNETES_API_SERVER}" \
  --from-file=oidc-ca.crt=identity-pilot-ca.crt \
  --dry-run=client -o yaml | kubectl apply -f -
```

Die Dashboard-Kubeconfig enthält später nur öffentliche CAs und den
`kubectl oidc-login`-Aufruf. Sie enthält weder Passwort noch Token oder
Client-Secret. Kann dein Control Plane den lokalen Issuer nicht zuverlässig
erreichen, erstelle die Bestätigungs-ConfigMap nicht und lasse den Download
deaktiviert, bis ein passender DNS-/Netzwerkpfad geplant ist.

### 6. Einmaligen Einrichtungscode erzeugen

Auf einem Appliance-Host erledigt dies die lokale Host-Automatisierung. In
einem bestehenden Cluster führst du den folgenden Bootstrap einmalig von einem
geschützten Administrator-Terminal aus. Kubernetes erhält ausschließlich den
SHA-256-Hash; der Klartextcode wird nur einmal im Terminal ausgegeben.

Prüfe zunächst, dass noch kein Setup-Zustand existiert:

```bash
kubectl -n identity-system get appliancesetup local
```

Wenn der Befehl eine vorhandene Ressource anzeigt, stoppe hier. Überschreibe sie
nicht. Wenn `NotFound` erscheint, führe den folgenden Block vollständig aus:

```bash
set -eu

claim="$(python3 -c 'import secrets; a="0123456789abcdefghjkmnpqrstvwxyz"; print("".join(secrets.choice(a) for _ in range(8)))')"
claim_hash="$(CLAIM_VALUE="$claim" python3 -c 'import hashlib, os; print(hashlib.sha256(os.environ["CLAIM_VALUE"].encode()).hexdigest())')"
installation_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"

kubectl -n identity-system create secret generic magicstick-setup-claim \
  --from-literal="claim-sha256=$claim_hash" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f - <<EOF
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ApplianceSetup
metadata:
  name: local
  namespace: identity-system
spec:
  setupVersion: v1
  installationId: ${installation_id}
EOF

kubectl -n identity-system patch appliancesetup local \
  --subresource=status \
  --type=merge \
  -p '{"status":{"phase":"Pending"}}'

echo
echo "Einrichtungscode: $claim"
echo "Notiere diesen Code jetzt. Er wird nicht erneut ausgegeben."
unset claim claim_hash installation_id
```

Falls du den Code verlierst, initialisiere den Setup-Zustand nicht erneut. Bei
`Pending` oder `Failed` kannst du ausschließlich den Claim-Hash ersetzen:

```bash
phase="$(kubectl -n identity-system get appliancesetup local -o jsonpath='{.status.phase}')"
case "$phase" in
  Pending|Failed) ;;
  *) echo "Keine Neuausstellung in Phase $phase" >&2; exit 1 ;;
esac

claim="$(python3 -c 'import secrets; a="0123456789abcdefghjkmnpqrstvwxyz"; print("".join(secrets.choice(a) for _ in range(8)))')"
claim_hash="$(CLAIM_VALUE="$claim" python3 -c 'import hashlib, os; print(hashlib.sha256(os.environ["CLAIM_VALUE"].encode()).hexdigest())')"

kubectl -n identity-system create secret generic magicstick-setup-claim \
  --from-literal="claim-sha256=$claim_hash" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Neuer Einrichtungscode: $claim"
unset claim claim_hash phase
```

## Setup-Adresse ermitteln

Der Setup-Dienst erzeugt jetzt dynamisch einen separaten privaten Gateway:

```bash
kubectl -n identity-system get gateway magicstick-setup -w
```

Sobald eine Adresse angezeigt wird, öffne:

```text
https://<private-LoadBalancer-IP>:9443/setup
```

Der Gateway akzeptiert ausschließlich private und link-lokale Quelladressen.
Wenn keine Adresse erscheint, fehlt dem Cluster wahrscheinlich eine
LoadBalancer-Implementierung oder eine passende Adresszuweisung.

Bei einer selbstsignierten Zertifikatswarnung kannst du den Fingerabdruck aus
dem Cluster ermitteln:

```bash
kubectl -n identity-system get secret magicstick-setup-tls \
  -o go-template='{{index .data "tls.crt" | base64decode}}' | \
  openssl x509 -noout -fingerprint -sha256
```

Vergleiche ihn mit dem vom Browser angezeigten Zertifikat, gib den
Einrichtungscode ein und lege den ersten Administrator an.

## Abschluss prüfen

```bash
kubectl -n identity-system get appliancesetup local
kubectl -n flux-system get gitrepositories,kustomizations
kubectl -n identity-system get pods
kubectl -n ai-system get pods
kubectl -n ai get pods
```

Nach erfolgreicher Einrichtung gilt:

- `ApplianceSetup/local` steht auf `Completed`;
- der temporäre Gateway `magicstick-setup` und sein Service wurden entfernt;
- der normale Dashboard-Zugang leitet zum Keycloak-Login weiter;
- der neue Benutzer besitzt die Rollen `magicstick-user` und
  `magicstick-admin`.

Fahre anschließend mit
[Magic Stick im Dashboard einrichten](after-installation-dashboard.md) fort.

## DNS und mDNS

mDNS ist in bestehenden oder gerouteten Clustern nicht automatisch vom
Administrator-Rechner erreichbar. Für die Einrichtung ist das unkritisch,
solange du die private IP auf Port `9443` erreichst. Für den späteren Betrieb
kannst du reguläre DNS-Einträge auf die Envoy-LoadBalancer-Adresse setzen.

Bei einem lokalen Rancher-Desktop-Cluster kann zusätzlich die dokumentierte
[macOS-mDNS-Brücke](../operations.md)
verwendet werden. Sie ist keine Voraussetzung für die Kubernetes-Installation.

## Deinstallation

Die Flux-Kustomization verwaltet zahlreiche Namespaces, CRDs und persistente
Daten. Eine vollständige Deinstallation ist destruktiv und sollte erst nach
einem Backup geplant werden. Lösche deshalb nicht pauschal Namespaces oder Flux,
wenn der Cluster noch andere Anwendungen enthält.
