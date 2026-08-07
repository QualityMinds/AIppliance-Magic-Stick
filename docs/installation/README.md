# Magic Stick installieren

Diese Anleitungen richten sich an Anwenderinnen und Anwender, die Magic Stick
installieren möchten, ohne die interne Repository-Struktur kennen zu müssen.
Wähle den Weg, der zu deiner Ausgangslage passt:

| Ausgangslage | Anleitung | Empfehlung |
|---|---|---|
| Dedizierter PC oder Server | [Echte Hardware](bare-metal.md) | Der einfachste und vollständigste Appliance-Weg |
| Neue Cloud-VM mit Cloud-Init | [Neue virtuelle Maschine](cloud-init-vm.md) | Für Hetzner Cloud, Azure und vergleichbare Anbieter |
| Bereits installierte Ubuntu-VM | [Bestehende virtuelle Maschine](existing-vm.md) | Wenn Ubuntu schon läuft und die VM ausschließlich Magic Stick verwenden soll |
| Bereits vorhandener Kubernetes-Cluster | [Bestehender Kubernetes-Cluster](existing-kubernetes.md) | Für erfahrene Cluster-Administratoren |
| Installation und First-Run-Setup abgeschlossen | [Einrichtung im Dashboard](after-installation-dashboard.md) | Domains, Module, Modelle, Instanzen und SSO prüfen |

## Was bei allen Varianten gleich ist

- Die Standardinstallation verwendet das öffentliche Repository im
  `readonly-public`-Modus. Dafür ist kein GitHub-Token erforderlich.
- Das Dashboard und die Anwendungen werden nach der Einrichtung über Keycloak
  SSO geschützt.
- Bei einer Neuinstallation wird kein Standardpasswort erzeugt. Du legst den
  ersten Administrator selbst im First-Run-Setup an.
- Der Setup-Bildschirm ist über `https://<private-IP>:9443/setup` erreichbar.
  `https://magicstick.local` ist ein bequemer zusätzlicher Weg, aber keine
  Voraussetzung.
- Port `9443` darf nur aus einem privaten oder link-lokalen Netz erreichbar
  sein. Er darf nicht öffentlich ins Internet freigegeben werden.
- Zertifikatswarnungen sind beim ersten lokalen Aufruf erwartbar. Vergleiche den
  angezeigten Fingerabdruck mit der Ausgabe der lokalen Konsole beziehungsweise
  des Bootstrap-Terminals.

## Welche Variante soll ich wählen?

Nimm nach Möglichkeit die Installation auf [echter Hardware](bare-metal.md).
Sie installiert Ubuntu, K3s, Flux und Magic Stick als zusammengehörige
Appliance und stellt die lokalen Konsolenbefehle bereit.

Die Variante für eine [neue Cloud-VM](cloud-init-vm.md) erreicht denselben
Host-Zustand, startet aber von einem Ubuntu-Cloud-Image. In gerouteten
Cloud-Netzen funktioniert mDNS üblicherweise nicht; verwende dort die private
IP-Adresse.

Die Installation in einer [bestehenden Ubuntu-VM](existing-vm.md) verändert das
gesamte System und sollte deshalb nur auf einer dedizierten VM erfolgen.

Die Installation in einem [bestehenden Kubernetes-Cluster](existing-kubernetes.md)
installiert ausschließlich die Cluster-Komponenten. Host-Automatisierung,
Textkonsole und K3s werden dabei nicht eingerichtet.

## Nach der Installation

Führe das [First-Run-Setup](../first-run-setup.md) aus. Richte anschließend mit
der Anleitung [Nach der Installation: Magic Stick im Dashboard einrichten](after-installation-dashboard.md)
Domains, Module, Modelle und Anwendungsinstanzen ein. Für technische
Statusprüfungen steht zusätzlich die [Betriebsanleitung](../operations.md) zur
Verfügung.
