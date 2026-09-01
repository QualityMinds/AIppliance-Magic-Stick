# Installation auf einem bestehenden Linux-System

Dieser Weg installiert Magic Stick auf einem bereits laufenden Ubuntu-Host oder
in einer Ubuntu-VM. Er ist für ein **dediziertes** System gedacht. Die
Installation richtet K3s, Flux,
Netzwerkdienste und systemd-Timer ein und übernimmt damit die Kontrolle über
wesentliche Teile des Systems.

> Erstelle vor Beginn einen Snapshot oder ein vollständiges Backup. Verwende
> diese Anleitung nicht auf einer VM, auf der andere produktive Anwendungen
> oder bereits ein Kubernetes-Cluster laufen.

## Voraussetzungen

- Ubuntu Server 24.04 LTS;
- ein Benutzer mit `sudo`-Rechten;
- Internetzugang für Paket-, Container- und Helm-Downloads;
- eine private IP-Adresse und Zugriff aus demselben privaten Netz;
- keine bestehende K3s-Installation und keine Belegung der benötigten Ports,
  insbesondere `443` und `9443`.

Als brauchbare Ausgangsgröße empfehlen sich 4 vCPU, 16 GB RAM und 100 GB
Speicher. Erstelle unmittelbar vor der Installation einen VM-Snapshot.

## Empfohlener Weg: ein Installationsskript

Lade das Skript herunter und prüfe zuerst ausschließlich die Voraussetzungen:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/install-from-linux.sh \
  -o /tmp/install-from-linux.sh

less /tmp/install-from-linux.sh
sudo bash /tmp/install-from-linux.sh --preflight-only
```

Wenn die Prüfung erfolgreich ist, starte die Installation:

```bash
sudo bash /tmp/install-from-linux.sh
```

Das Skript:

- akzeptiert ausschließlich Ubuntu 24.04 auf `x86_64` oder ARM64;
- verweigert bestehendes K3s, vorhandenen Magic-Stick-Status sowie belegte
  Ports `443` und `9443`;
- verlangt mindestens 40 GiB freien Speicher;
- zeigt vor der Änderung noch einmal Quelle, Version und Zielverzeichnis;
- löst die gewünschte Git-Version auf und pinnt die Installation auf den
  konkreten Commit;
- erzeugt den `new-install`-Marker genau einmal und startet anschließend den
  bestehenden Ansible-Converge-Runner.

Für eine veröffentlichte Version kannst du einen Tag angeben:

```bash
sudo bash /tmp/install-from-linux.sh --ref <release-tag>
```

Zusätzliche Optionen zeigt `bash /tmp/install-from-linux.sh --help`.

## Manueller Fallback

Die folgenden Schritte bilden denselben Ablauf ohne den vorgeschalteten
Installations-Wrapper ab. Verwende sie zur Diagnose oder wenn du jeden Schritt
einzeln ausführen möchtest.

### 1. Basispakete installieren

```bash
sudo apt-get update
sudo apt-get install -y git ansible curl ca-certificates
```

### 2. Runtime-Einstellungen anlegen

Erstelle die Datei mit einem root-fähigen Editor:

```bash
sudoedit /etc/default/ai-appliance-repo
```

Füge folgenden Inhalt ein:

```dotenv
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
```

Setze sichere Dateirechte:

```bash
sudo chown root:root /etc/default/ai-appliance-repo
sudo chmod 0600 /etc/default/ai-appliance-repo
```

### 3. Repository installieren

```bash
sudo install -d -m 0755 /opt/ai-appliance
sudo git clone \
  --branch main \
  --single-branch \
  https://github.com/QualityMinds/AIppliance-Magic-Stick.git \
  /opt/ai-appliance/magicstick
```

Falls das Verzeichnis bereits existiert, stoppe hier und kläre zuerst, ob diese
VM schon einmal Magic Stick ausgeführt hat. Lösche oder überschreibe keine
bestehende Appliance-Installation.

### 4. Neuinstallation markieren

Dieser Schritt aktiviert den einmaligen First-Run-Prozess. Führe ihn **nur**
aus, wenn auf dieser VM noch nie Magic Stick installiert war:

```bash
sudo install -d -m 0700 -o root -g root /var/lib/magicstick/setup
sudo touch /var/lib/magicstick/setup/new-install
sudo chmod 0600 /var/lib/magicstick/setup/new-install
```

Erzeuge diesen Marker niemals erneut auf einer eingerichteten Appliance. Ein
späteres erneutes Aktivieren des Setup-Modus ist kein unterstützter Reset-Weg.

### 5. Installation starten

```bash
sudo bash \
  /opt/ai-appliance/magicstick/magic-host/roles/ansible-pull-timer/files/ai-appliance-converge
```

Die Installation kann mehrere Minuten dauern. Der Befehl ist idempotent und
kann nach einem technischen Fehler erneut ausgeführt werden.

## First-Run-Setup abschließen

Zeige die Zugangsdaten an:

```bash
sudo magicstick setup show
```

Öffne die dort genannte private Adresse:

```text
https://<private-IP>:9443/setup
```

Vergleiche den Zertifikatsfingerabdruck, gib den achtstelligen
Einrichtungscode ein und lege den ersten Administrator an. Die vollständige
Beschreibung steht unter [First-Run-Setup](../first-run-setup.md).

## Installation prüfen

```bash
sudo systemctl status k3s --no-pager
sudo k3s kubectl get nodes
sudo k3s kubectl -n flux-system get gitrepositories,kustomizations
sudo k3s kubectl -n identity-system get appliancesetup local
```

Nach dem Abschluss muss `ApplianceSetup/local` den Status `Completed` besitzen.
Das Dashboard leitet danach zum Keycloak-Login weiter. Fahre anschließend mit
[Magic Stick im Dashboard einrichten](after-installation-dashboard.md) fort.

## Bestehende Magic-Stick-Installation aktualisieren

Für ein Update einer vorhandenen Appliance darfst du weder den Marker
`new-install` noch einen neuen Setup-Status erzeugen. Verwende stattdessen den
bereits installierten Converge-Runner:

```bash
sudo /usr/local/sbin/ai-appliance-converge
```

Eine ältere Installation ohne First-Run-Status wird aus Sicherheitsgründen als
`CompletedLegacy` behandelt und nicht unauthentifiziert geöffnet.
