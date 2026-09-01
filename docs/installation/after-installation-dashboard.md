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

## 2. Benutzer verwalten

Öffne als Administrator **Users**. Dieser Tab bleibt für Viewer und Operator
unsichtbar und ist bei einer Installation ohne lokalen Keycloak nicht
verfügbar. Die Liste wird erst beim Öffnen geladen und zeigt nur menschliche
Benutzer, keine technischen Service Accounts.

So legst du einen lokalen Benutzer an:

1. Wähle **Create User**. Die Schaltfläche steht immer oben im geöffneten
   Benutzer-Tab.
2. Trage Benutzername, Vor- und Nachname sowie eine eindeutige E-Mail-Adresse
   ein.
3. Wähle das kleinste benötigte Zugriffslevel: **User**, **Viewer**,
   **Operator** oder **Administrator**.
4. Vergib ein temporäres Passwort mit mindestens zwölf Zeichen und bestätige
   es.
5. Wähle erneut **Create User**. Teile das temporäre Passwort über einen
   geeigneten sicheren Kanal; es wird im Dashboard nicht noch einmal angezeigt.
6. Lass den Benutzer sich anmelden und das temporäre Passwort direkt ändern.

Die Zugriffslevel bedeuten:

| Auswahl | Berechtigung |
|---|---|
| User | Anmeldung an SSO-geschützten Anwendungen |
| Viewer | zusätzlich lesender Dashboard-Zugriff |
| Operator | zusätzlich Module, Instanzen und Modelle verwalten |
| Administrator | zusätzlich Einstellungen und Benutzer verwalten |

Über **Edit**, **Access**, **Enable/Disable**, **Reset Password** und **Delete**
verwaltet ein Administrator lokale Konten. Das Löschen muss durch Eingabe des
exakten Benutzernamens bestätigt werden. Deaktivieren ist für vorübergehend
nicht benötigte Konten die sicherere und rückgängig machbare Wahl.

Benutzer aus Entra ID, Google, AWS oder einem anderen angebundenen Provider
erscheinen, nachdem Keycloak sie erstmals kennt. Ihr externes Profil und
Passwort werden weiterhin beim jeweiligen Provider verwaltet. Das Dashboard
kennzeichnet diese Aktionen als nicht verfügbar; lokale MagicStick-Rollen und
der lokale Aktivierungszustand können entsprechend der angezeigten
Möglichkeiten verwaltet werden. Lösche einen externen Schattenbenutzer nicht,
sondern deaktiviere ihn und sperre ihn zusätzlich beim externen Provider.

Die Appliance verhindert, dass du dich selbst deaktivierst, löschst oder deine
eigene Administratorrolle entfernst. Außerdem bleiben der geschützte
Recovery-Benutzer und mindestens ein aktiver lokaler Administrator erhalten.

## 3. Übersicht kontrollieren

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

## 4. Domains und lokale Adresse prüfen

Öffne **Settings**. Dort findest du:

- **Public Domain**: gemeinsame Basis für öffentlich auflösbare
  Anwendungsnamen;
- **mDNS Domain**: lokale Dashboard-Adresse, normalerweise
  `magicstick.local`.

Ändere nur Werte, deren DNS- beziehungsweise mDNS-Auflösung du auch bereitstellen
kannst. Speichere mit **Save Domains**. Die Routen werden anschließend neu
erzeugt. Bei einer Änderung der mDNS-Domain musst du das Dashboard danach unter
dem neuen Namen öffnen. Das Dashboard ist immer direkt unter der Public Domain
und der mDNS Domain erreichbar; ein separater Dashboard-Hostname ist nicht
erforderlich. Eine öffentliche Domain allein macht die Appliance nicht automatisch
aus dem Internet erreichbar; DNS, Firewall und Netzwerkzugang müssen separat
eingerichtet sein.

## 5. Systemzustand prüfen

Öffne **System Status** und kontrolliere:

- **Flux**: alle erforderlichen Kustomizations sollten `Ready` sein;
- **Pods**: die laufenden Pods sollten sich nach der Startphase stabilisieren;
- **Gateway Routes**: verwendete Routen sollten `Accepted` melden.
- **GPU Operators**: NVIDIA, AMD und Intel zeigen `NotRequired`, solange keine
  passende Hardware erkannt wurde; ein benötigter Anbieter durchläuft
  `Detected`, `Installing` und schließlich `Ready`.

Kurzzeitige Zustände während der Installation sind normal. Bleibt ein Zustand
länger als einige Minuten unverändert oder wird `Degraded` angezeigt, verwende
die [Betriebs- und Fehlerdiagnose](../operations.md), bevor du weitere Module
installierst.

## 6. Gewünschte Betriebsart wählen

Entscheide vor der Modellinstallation, ob du lokale oder externe KI-Modelle
verwenden möchtest.

### Rechner mit unterstützter NVIDIA-GPU

NFD erkennt die GPU und der Magic Stick installiert automatisch den passenden
NVIDIA Operator. Warte unter **System Status**, bis der Anbieter `Ready` meldet.
Füge dann unter **Models → Local Model** ein lokales Modell hinzu und wähle
**NVIDIA GPU**. KubeAI wird dabei automatisch ergänzt. Das Modell bleibt
während des Starts gegebenenfalls in `WaitingForModules` oder `WaitingForGPU`.

### Rechner ohne unterstützte NVIDIA-GPU

Wähle für ein kleines, passendes lokales Preset **CPU**. Dabei wird KubeAI ohne
GPU-Treiber installiert; ausreichend RAM und CPU-Leistung bleiben erforderlich.
Alternativ verwende ein externes Modell. **LiteLLM** und **Model Catalog** sind
in beiden Fällen verfügbar. Ohne passende Hardware bleiben NVIDIA, AMD und
Intel in **System Status** auf `NotRequired` und verbrauchen keine
Vendor-Operator-Ressourcen.

## 7. Module installieren

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
| Lokales CPU-Modell | KubeAI wird automatisch ergänzt; kein GPU-Operator erforderlich |
| Lokales NVIDIA-Modell | KubeAI und der durch Hardware-Erkennung angeforderte NVIDIA Operator müssen `Ready` sein |
| AnythingLLM | AnythingLLM, LiteLLM, Model Catalog |
| OpenClaw-Instanz | OpenClaw Operator, LiteLLM, Model Catalog |
| Hermes-Instanz | Hermes Operator, LiteLLM, Model Catalog |
| Paperclip-Instanz | Paperclip Operator, Agent Sandbox, LiteLLM, Model Catalog |
| KubeOpenCode-Instanz | KubeOpenCode, LiteLLM, Model Catalog |
| Odysseus-Instanz | Odysseus, LiteLLM, Model Catalog |

## 8. Ein Modell hinzufügen

Öffne **Models** und klappe **Create Model** auf.

### Lokales Modell

Ein lokales Modell kann aktuell mit vLLM auf **CPU** oder **NVIDIA GPU** laufen.
Nicht verfügbare Ziele sind deaktiviert und nennen den Grund. AMD und Intel
werden bereits als Provider überwacht, sind aber erst nach eigenen vLLM-
Laufzeitprofilen als Modellziel auswählbar:

1. Vergib einen eindeutigen Namen aus Kleinbuchstaben, Ziffern und Bindestrichen.
2. Wähle **CPU** oder eine verfügbare **NVIDIA GPU** als Compute-Ziel.
3. Wähle ein zum Ziel passendes **Preset** oder **Custom**.
4. Wähle `chat` oder `embedding` als Typ.
5. Prüfe für NVIDIA **VRAM Estimate**; für CPU gelten stattdessen die
   RAM-Angaben des Presets.
6. Prüfe bei einem eigenen Modell die öffentliche HuggingFace-Adresse, die
   Kontextgröße und die maximale Zahl paralleler Sequenzen.
7. Wähle **Add Local Model**.
8. Warte unter **Installed Models**, bis das Modell `Ready` ist.

Ein zu großes Modell kann weder durch eine kleinere VRAM-Grenze noch durch ein
CPU-Ziel mit zu wenig RAM lauffähig gemacht werden. Wähle ein kleineres Modell
oder reduziere Kontextgröße und Parallelität.

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

## 9. Eine Anwendung oder Instanz erstellen

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

Auch das aktivierte LiteLLM-Modul zeigt unter **Modules → LiteLLM** die
Schaltfläche **Credentials** für Operatoren und Administratoren. Dort findest
du den Benutzernamen `admin`, das generierte UI-Passwort, den API-Master-Key und
die passenden API-Adressen. Die Werte werden erst beim Öffnen des Bereichs
abgerufen und dürfen nicht weitergegeben werden.

## 10. Anwendung öffnen und SSO prüfen

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

## 11. Änderungen sicher entfernen

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
2. In **Users** weitere lokale Benutzer mit möglichst kleinen Zugriffsrechten
   anlegen und den Recovery-Benutzer unangetastet lassen.
3. In **Settings** lokale und öffentliche Namen kontrollieren.
4. Betriebsart wählen: lokale GPU-Modelle oder externer API-Anbieter.
5. Benötigte Module aktivieren und jeweils auf `Ready` warten.
6. Mindestens ein Chat-Modell bereitstellen.
7. Gewünschte Anwendungsmodule aktivieren.
8. Instanzen mit **SSO protected** und zunächst **Local host only** erstellen.
9. Anwendung öffnen und SSO sowie Rollen prüfen.

Für technische Details zum Dashboard siehe
[Dashboard-Architektur und API](../dashboard.md). Für Störungen und
Statusprüfungen siehe [Betrieb und Fehlersuche](../operations.md).
