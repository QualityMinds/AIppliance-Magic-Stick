# Installation auf echter Hardware

Dieser Weg macht aus einem dedizierten x86-64-PC oder Server eine vollständige
Magic-Stick-Appliance. Das Installationsabbild basiert auf Ubuntu Server 26.04.1
LTS mit dessen nativem Generic-Kernel und richtet Ubuntu, K3s, Flux, Keycloak
und das Dashboard ein.

> **Achtung:** Die Ubuntu-Installation kann den ausgewählten Zieldatenträger
> vollständig löschen. Sichere vorhandene Daten und prüfe die Datenträgernamen
> sorgfältig.

## Voraussetzungen

Du benötigst:

- einen dedizierten x86-64-Rechner, der von USB booten kann;
- eine kabelgebundene Netzwerkverbindung oder einen vom Ubuntu-Installer
  unterstützten WLAN-Adapter mit Internetzugang;
- einen leeren USB-Stick mit mindestens 8 GB;
- einen zweiten Rechner mit Git und Docker oder Podman zum Erstellen des
  Installationssticks;
- mindestens einen weiteren Rechner mit Webbrowser im selben privaten Netz.

Als brauchbare Ausgangsgröße empfehlen sich 4 CPU-Kerne, 16 GB RAM und 100 GB
Speicher. Lokale KI-Modelle benötigen je nach Modell deutlich mehr RAM,
Speicherplatz und gegebenenfalls eine geeignete NVIDIA-, AMD- oder Intel-GPU.
Die neue Ubuntu-Basis ist keine pauschale GPU-Freigabe: Beachte die
[Operator- und Hardwaregrenzen](../modules.md#ubuntu-2604-baseline), insbesondere
den weiterhin experimentellen Strix-Halo-Pfad.

## 1. Repository herunterladen

Öffne auf dem Rechner, mit dem du den USB-Stick erstellst, ein Terminal:

```bash
git clone https://github.com/QualityMinds/AIppliance-Magic-Stick.git
cd AIppliance-Magic-Stick
```

## 2. Installationsabbild erzeugen

Erzeuge das öffentliche Standardabbild:

```bash
magic-installer/build-installer-image.sh \
  --hostname magicstick-01 \
  --output dist/magicstick-installer.img
```

Der Builder lädt das geprüfte Ubuntu-Installationsmedium und erzeugt ein
bootfähiges Abbild mit einer `CIDATA`-Partition. In diesem Standardmodus wird
kein Zugangstoken in das Abbild geschrieben.

Optional kannst du den später gewünschten lokalen Namen vorgeben:

```bash
magic-installer/build-installer-image.sh \
  --hostname magicstick-01 \
  --mdns-domain magicstick.local \
  --output dist/magicstick-installer.img
```

## 3. USB-Stick beschreiben

Lass dir zuerst die erkannten Wechselmedien anzeigen:

```bash
magic-installer/write-usb.sh --list-devices
```

Schreibe danach das Abbild auf den **gesamten** USB-Datenträger:

```bash
magic-installer/write-usb.sh \
  --image dist/magicstick-installer.img \
  --device /dev/diskN
```

Unter Linux heißt das Gerät häufig `/dev/sdX`, unter macOS `/dev/diskN`.
Verwende keine Partitionsbezeichnung wie `/dev/sdX1`.

Unter Windows stehen entsprechende PowerShell-Befehle zur Verfügung:

```powershell
.\magic-installer\build-installer-image.ps1 `
  -Hostname magicstick-01 `
  -Output dist\magicstick-installer.img

.\magic-installer\write-usb.ps1 -ListDevices
.\magic-installer\write-usb.ps1 `
  -Image .\dist\magicstick-installer.img `
  -DiskNumber 3
```

## 4. Zielrechner installieren

1. Stecke den USB-Stick in den ausgeschalteten Zielrechner.
2. Öffne das Boot-Menü des Rechners und starte vom USB-Stick.
   **Try or Install Ubuntu Server** startet den Magic-Stick-Autoinstall mit
   dem nativen Generic-Kernel von Ubuntu 26.04.1. Ein zusätzlicher
   Ubuntu-24.04-HWE-Bootpfad ist für dieses Abbild nicht erforderlich.
3. Konfiguriere im interaktiven Netzwerkabschnitt Ethernet oder WLAN. Bei WLAN
   wählst du den erkannten Adapter und gibst SSID sowie Passwort direkt am
   Zielrechner ein. Diese Zugangsdaten sind nicht im USB-Abbild enthalten.
4. Prüfe vor dem Fortfahren, dass der Installer eine IP-Adresse und Zugang zum
   Internet erhalten hat.
5. Prüfe anschließend die interaktive Auswahl des Ubuntu-Paketspiegels. Per
   GeoIP kann Subiquity einen Länderspiegel vorschlagen; du kannst die
   vorgeschlagene Adresse bestätigen oder eine eigene Mirror-URL eingeben.
   Das Ubuntu-Hauptarchiv bleibt die Rückfalloption. Die geografische Auswahl
   misst keine Downloadgeschwindigkeit und garantiert nicht den schnellsten
   Server. Ohne nutzbaren Spiegel und Internetzugang kann der vollständige
   Magic-Stick-Bootstrap nicht abgeschlossen werden.
6. Lege einen Linux-Benutzer für die lokale Administration und optional SSH an.
   Dieser Linux-Benutzer ist nicht der spätere Dashboard-Benutzer.
7. Bestätige die Installation und warte, bis sich der Rechner am Ende
   ausgeschaltet hat. Der Installer ist bewusst auf **Poweroff** eingestellt.
8. Entferne den USB-Stick und schalte den Rechner wieder ein, damit Ubuntu
   vom installierten Zieldatenträger startet.

Das Zielsystem erhält den nativen Generic-Kernelzweig von Ubuntu 26.04;
es wird kein Ubuntu-24.04-HWE-Paket installiert. Details stehen unter
[Kernel-Auswahl](../../magic-installer/README.md#kernel-selection).
Bestehende USB-Sticks müssen für die neue Ubuntu-Basis neu erstellt und
beschrieben werden; private `CIDATA`-Einstellungen vorher sichern.
Eine bereits installierte Ubuntu-24.04-Appliance wird durch den neuen Builder
oder ein Git-/Flux-Update nicht auf Ubuntu 26.04 aktualisiert. Diese Anleitung
beschreibt eine Neuinstallation, kein In-place-Release-Upgrade.

Die WLAN-Auswahl wird von Subiquity als Netplan-Konfiguration in das installierte
System übernommen. Ein Netz mit Captive Portal oder ein nicht vom Live-System
unterstützter WLAN-Chipsatz eignet sich nicht für den automatischen Bootstrap;
verwende dafür zunächst Ethernet. Eine stabile kabelgebundene Verbindung bleibt
für die größeren Container- und Modell-Downloads die zuverlässigste Variante.

Nach dem ersten Ubuntu-Start läuft die Bereitstellung automatisch weiter. K3s,
Flux und die Plattform benötigen abhängig von Hardware und Internetverbindung
mehrere Minuten. Währenddessen sind Installationsmeldungen auf der Konsole
normal. Nach dem Ende von cloud-init wechselt der Bildschirm automatisch von
der Protokollkonsole 1 auf die separate Magic-Stick-Einrichtungskonsole 9.
Dadurch können spätere Bootmeldungen den Einrichtungscode nicht überschreiben.
Die Anzeige erscheint als zentrierte, farblich gegliederte Appliance-Seite und
hebt den einmaligen Code deutlich von Adressen und Zertifikatsdaten ab.

## 5. First-Run-Setup öffnen

Die lokale Textkonsole zeigt nach der Bereitstellung:

- den konfigurierten `.local`-Namen;
- genau eine primäre private LAN-IP-Adresse;
- die Setup-Adresse auf Port `9443`;
- den achtstelligen einmaligen Einrichtungscode;
- den Fingerabdruck des temporären TLS-Zertifikats.

Interne Kubernetes-, Container-, Loopback- und virtuelle Netzwerkadressen
werden absichtlich ausgeblendet. Die Seite wird regelmäßig aktualisiert und
nach erfolgreichem Abschluss erneut geleert; der Einrichtungscode bleibt dann
nicht auf dem Bildschirm stehen.

Mit `Ctrl`+`Alt`+`F1` kannst du zur Boot- und Anmeldekonsole wechseln. Mit
`Ctrl`+`Alt`+`F9` kehrst du zur Einrichtungsseite zurück.

Falls die Anzeige nicht mehr sichtbar ist, melde dich auf der Textkonsole oder
per SSH an und führe aus:

```bash
sudo magicstick setup show
```

Dieser Befehl gibt die Informationen im aktuellen Terminal aus, ohne dessen
Inhalt zu löschen. `sudo magicstick setup reissue` erzeugt vor Abschluss einen
neuen Code und aktualisiert außerdem die physische Anzeige.

Öffne von einem Rechner im selben privaten Netz:

```text
https://<private-IP>:9443/setup
```

Alternativ kannst du `https://magicstick.local` verwenden, wenn mDNS in deinem
Netz funktioniert. Vergleiche vor der Eingabe des Codes den
Zertifikatsfingerabdruck. Lege anschließend den ersten Administrator an.

## 6. Installation prüfen

Auf dem Appliance-Host:

```bash
sudo systemctl status k3s --no-pager
sudo k3s kubectl get nodes
sudo k3s kubectl -n flux-system get kustomizations
sudo k3s kubectl -n identity-system get appliancesetup local
```

Nach erfolgreichem Abschluss steht der Setup-Status auf `Completed`, der
temporäre Zugang auf Port `9443` wird entfernt und das Dashboard verlangt die
Anmeldung über Keycloak. Fahre anschließend mit
[Magic Stick im Dashboard einrichten](after-installation-dashboard.md) fort.

## Fehlerdiagnose

```bash
sudo cloud-init status --long
sudo journalctl -u cloud-final -b --no-pager
sudo journalctl -u k3s -b --no-pager
sudo /usr/local/sbin/ai-appliance-converge
sudo magicstick setup show
```

Weitere Prüfungen findest du unter [Betrieb und Fehlersuche](../operations.md).
