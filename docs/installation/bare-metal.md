# Installation auf echter Hardware

Dieser Weg macht aus einem dedizierten x86-64-PC oder Server eine vollständige
Magic-Stick-Appliance. Das Installationsabbild basiert auf Ubuntu Server 24.04
LTS und richtet Ubuntu, K3s, Flux, Keycloak und das Dashboard ein.

> **Achtung:** Die Ubuntu-Installation kann den ausgewählten Zieldatenträger
> vollständig löschen. Sichere vorhandene Daten und prüfe die Datenträgernamen
> sorgfältig.

## Voraussetzungen

Du benötigst:

- einen dedizierten x86-64-Rechner, der von USB booten kann;
- eine kabelgebundene Netzwerkverbindung mit Internetzugang;
- einen leeren USB-Stick mit mindestens 8 GB;
- einen zweiten Rechner mit Git und Docker oder Podman zum Erstellen des
  Installationssticks;
- mindestens einen weiteren Rechner mit Webbrowser im selben privaten Netz.

Als brauchbare Ausgangsgröße empfehlen sich 4 CPU-Kerne, 16 GB RAM und 100 GB
Speicher. Lokale KI-Modelle benötigen je nach Modell deutlich mehr RAM,
Speicherplatz und gegebenenfalls eine unterstützte NVIDIA-GPU.

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
3. Wähle im Ubuntu-Installer Sprache, Tastatur, Netzwerk und Zieldatenträger.
4. Lege einen Linux-Benutzer für die lokale Administration und optional SSH an.
   Dieser Linux-Benutzer ist nicht der spätere Dashboard-Benutzer.
5. Bestätige die Installation und warte auf den Neustart.
6. Entferne den USB-Stick, wenn der Installer dazu auffordert.

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
