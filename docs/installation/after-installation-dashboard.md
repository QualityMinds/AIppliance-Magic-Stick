# Nach der Installation: Magic Stick im Dashboard einrichten

Diese Anleitung beginnt nach dem erfolgreichen First-Run-Setup. Der erste
Administrator wurde angelegt, der temporäre Setup-Zugang auf Port `9443` ist
entfernt und die normale Magic-Stick-Adresse zeigt den Keycloak-Login.

Im Dashboard stellst du anschließend die Domains ein, prüfst den Systemzustand,
aktivierst die gewünschten Module und Modelle und legst Anwendungen an.

## 1. Am Dashboard anmelden

Öffne die lokale Adresse, die du im Setup festgelegt hast, zum Beispiel:

```text
https://magicstick.local
```

Wenn mDNS nicht funktioniert, verwende den für das Dashboard eingerichteten
DNS-Namen. Die frühere Adresse `https://<private-IP>:9443/setup` ist nach dem
Setup absichtlich nicht mehr erreichbar.

1. Wähle auf der Keycloak-Seite **Sign in**.
2. Melde dich mit dem Administrator-Benutzernamen und Passwort aus dem
   First-Run-Setup an.
3. Prüfe im Dashboard-Kopf, ob **Signed in: <Benutzername>** und der Zustand
   **Connected** angezeigt werden.

Der Recovery-Benutzer ist für Notfälle gedacht. Verwende ihn nicht als
alltägliches Administratorkonto.

## 2. Übersicht kontrollieren

Öffne **Overview**. Die vier Karten zeigen den Zustand der Appliance sowie die
Anzahl aktivierter Module, angeforderter Instanzen und installierter Modelle.

Prüfe insbesondere den Bereich **Attention**:

- **No issues** bedeutet, dass aktuell kein bekannter Fehler vorliegt.
- **Requested**, **Waiting** oder **Reconciling** sind während einer
  Installation normal.
- **Degraded** oder eine dauerhaft wartende Ressource muss untersucht werden.

Das Dashboard aktualisiert sich alle 30 Sekunden. Eine angeforderte Änderung
ist deshalb nicht sofort abgeschlossen. Warte immer auf **Ready**, bevor du den
nächsten davon abhängigen Schritt startest.

## 3. Domains und lokale Adresse prüfen

Öffne **Settings**. Dort findest du:

- **Public Domain**: gemeinsame Basis für öffentlich auflösbare
  Anwendungsnamen;
- **mDNS Domain**: lokale Dashboard-Adresse, normalerweise
  `magicstick.local`;
- **Dashboard Public Host**: öffentlicher DNS-Name des Dashboards.

Ändere nur Werte, deren DNS- beziehungsweise mDNS-Auflösung du auch bereitstellen
kannst. Speichere mit **Save Domains**. Die Routen werden anschließend neu
erzeugt. Bei einer Änderung der mDNS-Domain musst du das Dashboard danach unter
dem neuen Namen öffnen.

Der Bereich **Addresses** zeigt die daraus abgeleiteten Dashboard- und
Anwendungsadressen. Eine öffentliche Domain allein macht die Appliance nicht
automatisch aus dem Internet erreichbar; DNS, Firewall und Netzwerkzugang
müssen separat eingerichtet sein.

## 4. Systemzustand prüfen

Öffne **System Status** und kontrolliere:

- **Flux**: alle erforderlichen Kustomizations sollten `Ready` sein;
- **Pods**: die laufenden Pods sollten sich nach der Startphase stabilisieren;
- **Gateway Routes**: verwendete Routen sollten `Accepted` melden.

Kurzzeitige Zustände während der Installation sind normal. Bleibt ein Zustand
länger als einige Minuten unverändert oder wird `Degraded` angezeigt, verwende
die [Betriebs- und Fehlerdiagnose](../operations.md), bevor du weitere Module
installierst.

## 5. Gewünschte Betriebsart wählen

Entscheide vor der Modellinstallation, ob du lokale oder externe KI-Modelle
verwenden möchtest.

### Rechner mit unterstützter NVIDIA-GPU

Füge unter **Models → Local Model** ein lokales Modell hinzu. Beim ersten
lokalen Modell installiert der Operator automatisch **GPU** und **KubeAI**.
Das Modell bleibt währenddessen in `WaitingForModules` und anschließend
gegebenenfalls in `WaitingForGPU`. Sobald Kubernetes eine NVIDIA-GPU meldet,
wird das KubeAI-Modell erstellt.

### Rechner ohne unterstützte NVIDIA-GPU

Verwende ein externes Modell. Eine neue Installation enthält weder den NVIDIA
GPU Operator noch KubeAI. **LiteLLM** und **Model Catalog** bleiben aktiv; sie
werden für externe Modelle und viele Anwendungen benötigt.

## 6. Module installieren

Öffne **Modules**. Die Karten sind in **Core**, **AI Runtime**, **Apps** und
**Operators** gruppiert.

- **Basis** und **Dashboard** werden statisch verwaltet und besitzen keinen
  Schalter.
- Bei optionalen Modulen startet **Enable** die Installation.
- **Disable** entfernt die bereitgestellten Laufzeitressourcen. Abhängig vom
  Modul können persistente Daten erhalten bleiben.
- Unter **Configure** kannst du vor dem Aktivieren beispielsweise
  Speichergrößen einstellen.

Abhängigkeiten werden vom Operator berücksichtigt. Warte dennoch auf **Ready**,
bevor du ein davon abhängiges Modell oder eine Instanz anlegst.

Typische Modulauswahl:

| Ziel | Benötigte Module |
|---|---|
| Externe Modelle | LiteLLM, Model Catalog |
| Lokale Modelle | GPU und KubeAI werden automatisch ergänzt; LiteLLM und Model Catalog sind bereits vorhanden |
| AnythingLLM | AnythingLLM, LiteLLM, Model Catalog |
| OpenClaw-Instanz | OpenClaw Operator, LiteLLM, Model Catalog |
| Hermes-Instanz | Hermes Operator, LiteLLM, Model Catalog |
| Paperclip-Instanz | Paperclip Operator, Agent Sandbox, LiteLLM, Model Catalog |
| KubeOpenCode-Instanz | KubeOpenCode, LiteLLM, Model Catalog |
| Odysseus-Instanz | Odysseus, LiteLLM, Model Catalog |

## 7. Ein Modell hinzufügen

Öffne **Models** und klappe **Create Model** auf.

### Lokales Modell

Verwende **Local Model** nur auf einem Rechner mit unterstützter NVIDIA-GPU.
Das Anlegen des ersten lokalen Modells installiert den GPU Operator und KubeAI
automatisch:

1. Vergib einen eindeutigen Namen aus Kleinbuchstaben, Ziffern und Bindestrichen.
2. Wähle ein vorhandenes **Preset** oder **Custom**.
3. Wähle `chat` oder `embedding` als Typ.
4. Prüfe **VRAM Estimate** und verwende möglichst **Recommended**.
5. Prüfe bei einem eigenen Modell die öffentliche HuggingFace-Adresse, die
   Kontextgröße und die maximale Zahl paralleler Sequenzen.
6. Wähle **Add Local Model**.
7. Warte unter **Installed Models**, bis das Modell `Ready` ist.

Ein zu großes Modell kann nicht durch eine kleinere VRAM-Grenze lauffähig
gemacht werden. Wähle in diesem Fall ein kleineres Modell oder reduziere
Kontextgröße und Parallelität.

### Externes Modell

Unter **External Model** kannst du einen kompatiblen API-Anbieter anbinden:

1. Vergib einen eindeutigen lokalen Namen.
2. Trage die Modellkennung des Anbieters unter **Provider Model** ein.
3. Trage den API-Endpunkt unter **API Base** ein.
4. Wähle Modelltyp und Kontextgröße.
5. Trage den API-Schlüssel ein und wähle **Add External Model**.
6. Warte unter **Installed Models**, bis das Modell `Ready` ist.

Der API-Schlüssel wird als Kubernetes Secret gespeichert und nicht wieder im
Dashboard angezeigt. Cluster-Administratoren können technisch auf dieses
Secret zugreifen. Beachte außerdem Kosten-, Datenschutz- und
Datenübertragungsregeln des gewählten Anbieters.

## 8. Eine Anwendung oder Instanz erstellen

Aktiviere unter **Modules** zuerst die für deine Anwendung benötigten Module.
Sobald diese `Ready` sind, öffne **Instances** und klappe **Create Instance**
auf. Es werden nur Anwendungen angezeigt, deren Voraussetzungen installiert
sind.

Für eine neue Instanz:

1. Vergib einen eindeutigen Namen, beispielsweise `default` oder `team-a`.
2. Wähle ein bereits bereitgestelltes Chat-Modell.
3. Lass **Access** normalerweise auf **SSO protected**.
4. Wähle unter **Minimum Role**, welche Keycloak-Rolle zugreifen darf.
5. Verwende **Local host only**, solange kein öffentlicher DNS- und
   Netzwerkzugang eingerichtet ist.
6. Prüfe unter **Configure** die Speichergrößen.
7. Wähle **Create <Anwendung>** und warte auf `Ready`.

Die Option **Public without login** schaltet die Gateway-Authentifizierung für
diese Anwendung bewusst aus. Verwende sie nur, wenn ein unauthentifizierter
Zugriff ausdrücklich gewünscht und sicher bewertet wurde.

Der Hostname wird automatisch gebildet:

```text
<instanzname>.<anwendung>.<domain>
```

Eine OpenClaw-Instanz `default` ist lokal beispielsweise unter
`default.openclaw.magicstick.local` erreichbar.

Einige Instanzen zeigen nach der Installation die Schaltfläche **Credentials**.
Öffne sie nur in einer geschützten Administratorsitzung und bewahre angezeigte
Zugangsdaten sicher auf.

## 9. Anwendung öffnen und SSO prüfen

Nach dem Zustand `Ready` erscheint die Adresse auf der Instanzkarte und unter
**Overview → Available Apps**.

1. Öffne die lokale Adresse der Anwendung.
2. Prüfe, dass du zu Keycloak weitergeleitet wirst.
3. Melde dich mit dem angelegten Benutzer an.
4. Prüfe, dass die Anwendung anschließend ohne einen zweiten separaten Login
   geöffnet wird.

Falls du `Viewer`, `Operator` oder `Administrator` als Mindestrolle gewählt
hast, benötigt der Benutzer die entsprechende Keycloak-Rolle. Ein erfolgreicher
Login mit anschließendem `403` bedeutet normalerweise, dass die Rolle fehlt.

## 10. Änderungen sicher entfernen

- Modelle entfernst du unter **Models** mit **Remove**.
- Wenn kein lokales Modell mehr vorhanden ist, entfernt **Remove Local GPU
  Runtime** die automatisch installierten KubeAI- und GPU-Module.
- Instanzen entfernst du unter **Instances** mit **Remove**.
- Module deaktivierst du unter **Modules** mit **Disable**.

Entferne zuerst die abhängigen Instanzen und Modelle und danach deren Module.
Das Entfernen einer Instanz oder eines Moduls kann Daten löschen oder
persistente Volumes bewusst zurücklassen. Erstelle vor produktiven Änderungen
ein Backup nach deinem späteren Backup- und Restore-Konzept.

## Empfohlene Reihenfolge für eine neue Appliance

1. In **Overview** und **System Status** einen stabilen Grundzustand prüfen.
2. In **Settings** lokale und öffentliche Namen kontrollieren.
3. Betriebsart wählen: lokale GPU-Modelle oder externer API-Anbieter.
4. Benötigte Module aktivieren und jeweils auf `Ready` warten.
5. Mindestens ein Chat-Modell bereitstellen.
6. Gewünschte Anwendungsmodule aktivieren.
7. Instanzen mit **SSO protected** und zunächst **Local host only** erstellen.
8. Anwendung öffnen und SSO sowie Rollen prüfen.

Für technische Details zum Dashboard siehe
[Dashboard-Architektur und API](../dashboard.md). Für Störungen und
Statusprüfungen siehe [Betrieb und Fehlersuche](../operations.md).
