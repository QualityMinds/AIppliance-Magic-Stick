# Neue virtuelle Maschine mit Cloud-Init

Dieser Weg installiert Magic Stick auf einer neuen Ubuntu-VM bei einem
Cloud-Anbieter wie Hetzner Cloud oder Microsoft Azure. Verwende ein frisches
Ubuntu-24.04-LTS-Cloud-Image und übergib die unten stehende Konfiguration als
Cloud-Init beziehungsweise `Custom Data`.

## Sicherheits- und Netzwerkhinweise

- Die VM sollte eine private IP-Adresse in einem VPC, VNet oder VPN besitzen.
- Öffne SSH nur für dein Administrationsnetz.
- Öffne HTTPS-Port `443` gemäß deinem späteren Nutzungskonzept.
- Öffne Setup-Port `9443` **nur** für dein privates Administrationsnetz und
  niemals für `0.0.0.0/0` oder `::/0`.
- mDNS wird über geroutete Cloud-Netze gewöhnlich nicht übertragen. Plane für
  die Einrichtung mit `https://<private-IP>:9443/setup`.

Als brauchbare Ausgangsgröße empfehlen sich 4 vCPU, 16 GB RAM und 100 GB
Speicher. KI-Modelle können erheblich mehr Ressourcen benötigen. x86-64 ist der
empfohlene Architekturpfad; verwende ARM64 nur, wenn alle gewünschten
Container-Images und Erweiterungen ARM64 unterstützen.

## 1. Cloud-Init vorbereiten

Speichere folgende Konfiguration lokal als `magicstick-cloud-init.yaml`:

```yaml
#cloud-config
package_update: true
packages:
  - git
  - ansible
  - curl
  - ca-certificates

manage_etc_hosts: true

write_files:
  - path: /etc/default/ai-appliance-repo
    owner: root:root
    permissions: "0600"
    content: |
      FLUX_BOOTSTRAP_MODE=readonly-public
      MAGICSTICK_PUBLIC_REPO=https://github.com/QualityMinds/AIppliance-Magic-Stick.git
      MAGICSTICK_PUBLIC_REF=main
      MAGICSTICK_PUBLIC_REF_KIND=branch
      FLUX_PUBLIC_SYNC_PATH=magic-cluster/flux/entrypoints/single-node

      AI_APPLIANCE_DOMAIN=magicstick.example.com
      AI_APPLIANCE_DASHBOARD_HOST=magicstick.example.com
      AI_APPLIANCE_MDNS_DOMAIN=magicstick.local
      AI_APPLIANCE_MDNS_NAME=magicstick
      AI_APPLIANCE_DASHBOARD_MDNS_NAME=magicstick

runcmd:
  - install -d -m 0700 -o root -g root /var/lib/magicstick/setup
  - touch /var/lib/magicstick/setup/new-install
  - chmod 0600 /var/lib/magicstick/setup/new-install
  - >-
    /bin/bash -lc '. /etc/default/ai-appliance-repo &&
    MAGICSTICK_PUBLIC_REPO="${MAGICSTICK_PUBLIC_REPO:-https://github.com/QualityMinds/AIppliance-Magic-Stick.git}" &&
    MAGICSTICK_PUBLIC_REF="${MAGICSTICK_PUBLIC_REF:-main}" &&
    MAGICSTICK_PUBLIC_REF_KIND="${MAGICSTICK_PUBLIC_REF_KIND:-branch}" &&
    MAGICSTICK_PUBLIC_CHECKOUT="${MAGICSTICK_PUBLIC_CHECKOUT:-/opt/ai-appliance/magicstick}" &&
    export GIT_TERMINAL_PROMPT=0 &&
    git_with_http11_fallback() {
      if git "$@"; then return 0; fi;
      echo "[magicstick] Git transport failed; retrying with HTTP/1.1." >&2;
      git -c http.version=HTTP/1.1 "$@";
    } &&
    git_clone_with_http11_fallback() {
      local repo_url="$1";
      local checkout_dir="$2";
      if git clone --no-checkout "$repo_url" "$checkout_dir"; then return 0; fi;
      echo "[magicstick] Git clone failed; retrying with HTTP/1.1." >&2;
      rm -rf "$checkout_dir";
      git -c http.version=HTTP/1.1 clone --no-checkout "$repo_url" "$checkout_dir";
    } &&
    mkdir -p "$(dirname "$MAGICSTICK_PUBLIC_CHECKOUT")" &&
    if [ -d "$MAGICSTICK_PUBLIC_CHECKOUT/.git" ]; then
      git -C "$MAGICSTICK_PUBLIC_CHECKOUT" remote set-url origin "$MAGICSTICK_PUBLIC_REPO";
    else
      rm -rf "$MAGICSTICK_PUBLIC_CHECKOUT" &&
      git_clone_with_http11_fallback "$MAGICSTICK_PUBLIC_REPO" "$MAGICSTICK_PUBLIC_CHECKOUT";
    fi &&
    git_with_http11_fallback -C "$MAGICSTICK_PUBLIC_CHECKOUT" fetch --tags --prune origin &&
    if [ "$MAGICSTICK_PUBLIC_REF_KIND" = branch ] && git -C "$MAGICSTICK_PUBLIC_CHECKOUT" show-ref --verify --quiet "refs/remotes/origin/$MAGICSTICK_PUBLIC_REF"; then
      git -C "$MAGICSTICK_PUBLIC_CHECKOUT" checkout --force -B "$MAGICSTICK_PUBLIC_REF" "origin/$MAGICSTICK_PUBLIC_REF";
    else
      git -C "$MAGICSTICK_PUBLIC_CHECKOUT" checkout --force --detach "$MAGICSTICK_PUBLIC_REF";
    fi &&
    bash "$MAGICSTICK_PUBLIC_CHECKOUT/magic-host/roles/ansible-pull-timer/files/ai-appliance-converge"'
```

Ersetze `magicstick.example.com`, wenn du bereits eine öffentliche Domain
kennst. Lass den Wert andernfalls unverändert und setze ihn später im
First-Run-Setup. Lege keine Passwörter oder Tokens in der Cloud-Init-Datei ab.

Der Bootstrap versucht Git zunächst mit dem vom System ausgehandelten
HTTPS-Protokoll. Schlägt dieser Transport fehl, erfolgt automatisch ein zweiter
Versuch über HTTP/1.1. Interaktive Passwortabfragen sind beim öffentlichen
Bootstrap deaktiviert, damit Cloud-init nicht unbemerkt hängen bleibt.

> Der Marker `new-install` ist absichtlich Teil dieser Konfiguration. Er darf
> nur beim erstmaligen Aufbau einer neuen VM erzeugt werden.

## 2. VM bei Hetzner Cloud erstellen

1. Erstelle ein Projekt und ein privates Netzwerk.
2. Erstelle einen Server mit Ubuntu 24.04 LTS und verbinde ihn mit dem privaten
   Netzwerk.
3. Füge deinen SSH-Schlüssel hinzu.
4. Füge den vollständigen Inhalt von `magicstick-cloud-init.yaml` im Feld
   **Cloud config** ein.
5. Beschränke die Cloud-Firewall wie oben beschrieben.
6. Erstelle die VM.

## 3. VM bei Microsoft Azure erstellen

1. Erstelle eine VM mit Ubuntu Server 24.04 LTS in einem VNet.
2. Verwende nach Möglichkeit eine private IP und administriere die VM über VPN,
   Bastion oder einen vergleichbaren privaten Zugang.
3. Füge deinen SSH-Schlüssel hinzu.
4. Öffne **Erweitert** und füge die Datei als **Benutzerdaten/Custom Data** im
   Cloud-Init-Format ein.
5. Beschränke die Network Security Group wie oben beschrieben.
6. Erstelle die VM.

Andere Anbieter funktionieren entsprechend, wenn sie unveränderte
`#cloud-config`-Benutzerdaten an ein Ubuntu-Cloud-Image übergeben.

## 4. Bereitstellung beobachten

Melde dich per SSH an und warte, bis Cloud-Init fertig ist:

```bash
sudo cloud-init status --wait
sudo cloud-init status --long
```

Die Plattformbereitstellung kann nach dem Abschluss von Cloud-Init noch einige
Minuten konvergieren. Prüfe sie mit:

```bash
sudo systemctl status k3s --no-pager
sudo k3s kubectl get nodes
sudo k3s kubectl -n flux-system get kustomizations
sudo magicstick setup show
```

`sudo magicstick setup show` zeigt den achtstelligen Einrichtungscode, die
private Setup-Adresse und den Zertifikatsfingerabdruck. Öffne anschließend:

```text
https://<private-IP>:9443/setup
```

Schließe das [First-Run-Setup](../first-run-setup.md) ab. Danach wird der
temporäre Setup-Zugang entfernt und das Dashboard ist über SSO geschützt.
Fahre anschließend mit
[Magic Stick im Dashboard einrichten](after-installation-dashboard.md) fort.

## Fehlerdiagnose

```bash
sudo journalctl -u cloud-final -b --no-pager
sudo journalctl -u k3s -b --no-pager
sudo /usr/local/sbin/ai-appliance-converge
sudo k3s kubectl -n flux-system get gitrepositories,kustomizations
```

Falls Cloud-Init die Datei nicht verarbeitet hat, prüfe beim Anbieter, ob die
Benutzerdaten wirklich als Cloud-Init und nicht als normales Startskript
übergeben wurden.
