# AmongUS Discord Bot

Discord-Bot fuer Real-Life Among Us. Der Bot erstellt eine Spiel-Session, verteilt Rollen und Tasks, verwaltet private Spieler-Kanaele, Meetings, Voting, Emergency-Meetings und den Taskfortschritt.

## Voraussetzungen

- Node.js installiert
- Ein Discord-Bot im Discord Developer Portal
- Der Bot muss auf deinem Discord-Server eingeladen sein
- Die Bot-Token und Client-ID aus dem Developer Portal

## Installation

Im Projektordner:

```powershell
npm install
```

Danach eine `.env` Datei anlegen. Am einfachsten die Vorlage kopieren:

```powershell
Copy-Item .env.example .env
```

## .env ausfuellen

Diese Werte musst du in `.env` eintragen:

```env
DISCORD_TOKEN=
CLIENT_ID=
```

`DISCORD_TOKEN` ist der Token deines Discord-Bots.

`CLIENT_ID` ist die Application ID bzw. Client ID deines Discord-Bots.

Optional kannst du diese Werte setzen:

```env
GUILD_ID=
ADMIN_ROLE=
DATABASE_PATH=./data/amongus.sqlite
TASKS_PATH=./data/tasks.json
KILL_COOLDOWN_SECONDS=30
DEFAULT_DISCUSSION_TIME_MINUTES=3
DEFAULT_VOTING_TIME_MINUTES=2
EMERGENCY_COOLDOWN_SECONDS=300
DEBUG_MODE=false
LOG_LEVEL=info
DEBUG_MAX_GHOST_PLAYERS=15
EXTRA_CA_CERT_PATH=
WEB_PANEL_ENABLED=true
WEB_PANEL_PORT=3000
ADMIN_PANEL_ENABLED=false
ADMIN_PANEL_PORT=3001
```

## Bedeutung der Einstellungen

`GUILD_ID`

Optional. Discord-Server-ID. Wenn gesetzt, werden Slash Commands nur auf diesem Server registriert. Das ist beim Testen schneller.

`ADMIN_ROLE`

Optional. Rollenname oder Rollen-ID fuer die Spielleitung. Wenn leer, reicht die Discord-Berechtigung `ManageGuild`.

`DATABASE_PATH`

Pfad zur SQLite-Datenbank. Standard ist `./data/amongus.sqlite`.

`TASKS_PATH`

Pfad zur Task-Datei. Standard ist `./data/tasks.json`.

`KILL_COOLDOWN_SECONDS`

Sekunden, die ein Impostor nach einem Kill warten muss.

`DEFAULT_DISCUSSION_TIME_MINUTES`

Standard-Dauer der Diskussion bei Meetings.

`DEFAULT_VOTING_TIME_MINUTES`

Standard-Dauer des Votings bei Meetings.

`EMERGENCY_COOLDOWN_SECONDS`

Cooldown fuer Emergency Meetings.

`EXTRA_CA_CERT_PATH`

Optionaler Pfad zu einem zusaetzlichen CA-Zertifikat, z.B. wenn ein Schul- oder Firmennetzwerk HTTPS-Zertifikate ersetzt.

Beispiel:

```env
EXTRA_CA_CERT_PATH=C:\Pfad\zum\schule.pem
```

Wenn der Wert leer ist oder die Datei nicht existiert, startet der Bot ohne Extra-Zertifikat.

`DEBUG_MODE`

Aktiviert zusaetzliche Debug-Logs fuer Bot-Abläufe.

`LOG_LEVEL`

Optionaler Platzhalter fuer kuenftige Log-Filterung. Standard ist `info`.

`DEBUG_MAX_GHOST_PLAYERS`

Maximale Anzahl an Ghost-Spielern fuer Debug-Runden.

## Webpanel

Das lokale Webpanel startet standardmaessig mit dem Bot. Es ist lokal ohne Login erreichbar; die API bindet an `127.0.0.1`.

Optional konfigurieren:

```env
WEB_PANEL_ENABLED=true
WEB_PANEL_PORT=3000
```

Nur `WEB_PANEL_ENABLED=false` deaktiviert das Webpanel explizit.

Die Seite ist lokal erreichbar:

```text
http://localhost:3000/
http://localhost:3000/panel
```

Das normale Webpanel zeigt ohne laufende Session nur `Aktuell läuft keine Session.`. Waehrend einer Session steuert es Emergency Meeting, Diskussion, Voting und Voting-Auswertung.

Optionales Adminpanel:

```env
ADMIN_PANEL_ENABLED=true
ADMIN_PANEL_PORT=3001
```

Routen:

```text
http://localhost:3001/
http://localhost:3001/admin
http://localhost:3001/panel/admin
```

Wenn `ADMIN_PANEL_ENABLED=false` gesetzt ist, bleibt das Adminpanel deaktiviert. Das Adminpanel braucht keinen Key mehr und laeuft stattdessen auf einem getrennten lokalen Port.

## Bot starten

Zum Entwickeln und Spielen direkt aus TypeScript:

```powershell
npm run dev
```

Der Bot startet dann und registriert die Discord Slash Commands.

Wenn alles klappt, erscheint ungefaehr:

```text
AmongUS Bot gestartet als BotName#1234
```

```text
Webpanel läuft auf http://localhost:3000
```

## Bot bauen

Zum Pruefen, ob TypeScript fehlerfrei kompiliert:

```powershell
npm run build
```

Gebauten Bot starten:

```powershell
npm start
```

## Discord-Befehle

Der Bot nutzt den Slash Command:

```text
/amongus
```

Typischer Ablauf:

1. Spielleitung erstellt eine Session.
2. Spieler treten bei.
3. Spielleitung startet das Spiel.
4. Der Bot erstellt private Spieler-Kanaele.
5. Spieler sehen dort ihre Rolle und Tasks.
6. Meetings, Voting, Kills, Reports und Tasks laufen ueber Discord-Buttons und das lokale Webpanel.

Debug-Ablauf:

1. `/amongus debug-create ghost_count:X` erstellt eine Debug-Runde.
2. Ghost-Spieler werden automatisch angelegt.
3. `/amongus debug-list` zeigt Ghosts, Rollen, Status und Taskfortschritt.
4. `/amongus debug-complete-task`, `/amongus debug-kill` und `/amongus debug-vote` simulieren Ghost-Aktionen.

## Tasks bearbeiten

Tasks stehen in:

```text
data/tasks.json
```

Einfache Task:

```json
{
  "id": "short_001",
  "title": "Sicherungskasten pruefen",
  "description": "Gehe zum Sicherungskasten und pruefe ihn.",
  "location": "Gang"
}
```

Multi-Step-Task:

```json
{
  "id": "long_001",
  "title": "Reaktor kalibrieren",
  "description": "Fuehre alle Kalibrierungsschritte aus.",
  "location": "Technikraum",
  "steps": [
    {
      "id": "step_1",
      "title": "Schalter A aktivieren"
    },
    {
      "id": "step_2",
      "title": "Code ablesen"
    }
  ]
}
```

Wichtig:

- `steps` ist optional.
- Ohne `steps` ist es eine normale Task.
- Multi-Step-Tasks zaehlen erst als erledigt, wenn alle Steps erledigt sind.
- Impostor-Fake-Tasks zaehlen nicht zum Crewmate-Fortschritt.

## Haeufige Probleme

### self-signed certificate in certificate chain

Wenn diese Meldung kommt, ersetzt dein Netzwerk wahrscheinlich HTTPS-Zertifikate. Dann das passende Root-Zertifikat als `.pem` speichern und in `.env` setzen:

```env
EXTRA_CA_CERT_PATH=C:\Pfad\zum\schule.pem
```

Danach:

```powershell
npm run dev
```

### Slash Commands erscheinen nicht

- Pruefe `DISCORD_TOKEN`
- Pruefe `CLIENT_ID`
- Setze optional `GUILD_ID` auf deine Discord-Server-ID
- Starte den Bot neu

### Webpanel geht nicht auf

- Pruefe, ob `WEB_PANEL_ENABLED=false` gesetzt ist
- Pruefe `WEB_PANEL_PORT`
- Pruefe, ob der Bot beim Start `Webpanel läuft auf http://localhost:3000` ausgibt
- Oeffne das Webpanel auf demselben Rechner, auf dem der Bot laeuft
