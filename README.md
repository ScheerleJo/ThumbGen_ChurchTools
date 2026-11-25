# ThumbGen_ChurchTools

Erstellt automatisch YouTube-Thumbnails (1920×1080) sowie Titel und Beschreibung für Livestream-Gottesdienste aus ChurchTools-Events.

## Einrichtung

```
npm install
cp .env.example .env   # Zugangsdaten eintragen
```

## Verwendung

```
npm run watch              # dauerhaft laufen, alle 15 min abgleichen, mit Dashboard
npm run dashboard          # nur Dashboard, Abgleich per Knopfdruck
node index.js              # einmal abgleichen: Events von heute bis in 7 Tagen
node index.js --days 14    # größerer Zeitraum
node index.js --event 191  # nur ein bestimmtes Event
node index.js --dry-run    # nur anzeigen, nichts schreiben
node index.js --rebuild    # alle Thumbnails neu erzeugen
node index.js --demo       # Beispiel-Thumbnails ohne ChurchTools
node index.js --help
```

Ergebnis pro Event in `output/`: `YYYY-MM-DD_HHMM_<Art>.jpeg` (Thumbnail) und `.txt` (YouTube-Titel + Beschreibung aus `assets/templates.json`).

## Abgleich

Jeder Lauf gleicht `output/` mit ChurchTools ab; was schon erzeugt wurde, merkt sich das Tool in `output/.state.json`:

- **neu**: Event mit Stream, abgeschlossener Agenda und Thema → Thumbnail wird erstellt
- **aktualisiert**: Thema, Uhrzeit, Art, Prediger, Predigttext, Vorlage oder Hintergrund geändert → neu erzeugt (bei Terminverschiebung wird die alte Datei entfernt)
- **entfernt**: Event abgesagt, Streaming nicht mehr `ja` oder Event gelöscht → Dateien werden gelöscht
- **unverändert**: nichts zu tun
- Wird eine Agenda wieder geöffnet, bleibt das bisherige Thumbnail stehen.
- Vergangene Events werden nicht mehr verfolgt, ihre Dateien bleiben liegen.

Mit `npm run watch` läuft das Tool dauerhaft und gleicht im Intervall `WATCH_INTERVAL_MINUTES` (Standard 15) ab. Netzwerk- oder Login-Fehler werden geloggt und beim nächsten Durchlauf erneut versucht. Damit es nach einem Neustart automatisch wieder läuft, z. B. in der Windows-Aufgabenplanung „Beim Start“ `node index.js --watch` im Projektordner starten lassen, oder auf einem Server mit pm2/systemd/Docker.

## Dashboard

`npm run watch` (oder `npm run dashboard`) startet zusätzlich ein Dashboard unter **http://127.0.0.1:3000** (Port: `DASHBOARD_PORT`). Dort siehst du für jedes Event im Zeitraum:

- das Thumbnail (Klick = große Ansicht), Thema, Art, Prediger und Predigttext
- ob die Agenda abgeschlossen ist und warum ggf. kein Thumbnail erstellt wurde
- die Rohdaten aus ChurchTools (Event-Notiz, Predigt-Eintrag) und den YouTube-Titel samt Beschreibung
- den Livestream mit Sichtbarkeit, Links zu YouTube und YouTube Studio

**Anpassen:** Passt etwas nicht, können Thema, Art, Prediger und Predigttext überschrieben werden – mit Live-Vorschau. Im Thema erzeugt Enter einen eigenen Zeilenumbruch im Thumbnail. Ist die Agenda noch offen, kann das Thumbnail trotzdem erzeugt werden. Beim Speichern werden Thumbnail und YouTube-Livestream sofort aktualisiert. Die Anpassungen liegen in `data/overrides.json` und gelten, bis man sie zurücksetzt; Änderungen in ChurchTools an *nicht* angepassten Feldern werden weiterhin übernommen.

**Freigabe-Ablauf:** Neue Livestreams werden *nicht gelistet* angelegt (`YOUTUBE_PRIVACY=unlisted`). Im Dashboard und in YouTube Studio prüfen, dann im Dashboard auf **„Öffentlich schalten“** klicken. Spätere Aktualisierungen ändern die Sichtbarkeit nicht.

Das Dashboard ist nur vom eigenen Rechner aus erreichbar und hat keine Anmeldung.

## Was in ChurchTools gepflegt sein muss

- **Event-Notiz** enthält `Streaming: ja`, sonst wird das Event übersprungen.
- **Event-Name** bestimmt die Art: enthält „Familien“ → Familiengottesdienst, „Jugend“ → Jugendgottesdienst, sonst Gottesdienst.
- **Agenda** ist abgeschlossen (final). Der Eintrag mit „Predigt“ im Titel hat in der Notiz:
  ```
  Thema: Der letzte Wille von Jesus: Einheit
  Predigttext: Johannes 17,20-26
  ```
  Als Fallback werden `Thema:` / `Predigttext:` auch in der Event-Notiz gesucht. Der Prediger kommt aus den zugesagten Verantwortlichen des Predigt-Eintrags.
- Events ohne abgeschlossene Agenda oder ohne Thema werden übersprungen (`--force` rendert sie trotzdem).

## Hintergründe

`assets/backgrounds/<art in kleinbuchstaben>.png`, z. B. `familiengottesdienst.png`. Fehlt eine Datei, wird `default.png` genutzt – für einen eigenen Jugendgottesdienst-Hintergrund reicht es also, `jugendgottesdienst.png` abzulegen.

## YouTube

Optional legt das Tool für jedes Event einen geplanten YouTube-Livestream an – mit Titel, Beschreibung, Startzeit und Thumbnail – und hält ihn beim Abgleich aktuell:

- **neu** → Livestream wird angelegt und an den Stream-Key gebunden
- **aktualisiert** → Titel, Beschreibung, Startzeit und Thumbnail werden aktualisiert (Sichtbarkeit und andere Einstellungen aus dem Studio bleiben)
- **entfernt** → Livestream wird gelöscht, aber nur, solange er noch nicht live war
- Im Studio gelöschte Livestreams werden beim nächsten Änderungsabgleich neu angelegt.
- Hat das Event schon begonnen, wird der Livestream nicht mehr angefasst.
- Schlägt YouTube fehl, bleibt das lokale Thumbnail erhalten und YouTube wird beim nächsten Lauf erneut versucht.

### Einrichtung (einmalig)

1. In der [Google Cloud Console](https://console.cloud.google.com/) ein Projekt anlegen und die **YouTube Data API v3** aktivieren.
2. **OAuth-Zustimmungsbildschirm**: Typ „Extern“, App-Name eintragen, eigenes Konto als Testnutzer hinzufügen. Danach den Status auf **„In Produktion“** stellen – im Status „Testing“ läuft die Anmeldung nach 7 Tagen ab. (Eine Prüfung durch Google ist für die eigene Nutzung nicht nötig; bei der Anmeldung erscheint nur ein Hinweis, dass die App nicht überprüft ist.)
3. **Anmeldedaten → OAuth-Client-ID** vom Typ **„Desktop-App“** erstellen, JSON herunterladen und als `youtube-client-secret.json` in den Projektordner legen.
4. Anmelden – mit dem Konto, das den YouTube-Kanal verwaltet:
   ```
   node index.js --youtube-auth
   ```
   Der Zugang wird in `youtube-token.json` gespeichert. Beide Dateien sind in `.gitignore` und dürfen nicht weitergegeben werden.
5. Stream-Key auswählen, den OBS benutzt:
   ```
   node index.js --youtube-streams
   ```
   Die ID in `.env` als `YOUTUBE_STREAM_ID` eintragen.
6. In `.env` `YOUTUBE_ENABLED=true` setzen, erst mit `node index.js --dry-run` prüfen, dann normal laufen lassen.

Neue Livestreams sind standardmäßig **nicht gelistet** (`YOUTUBE_PRIVACY`), damit man den ersten Test gefahrlos ansehen kann. Freigeben lässt sich ein Livestream dann im Dashboard per „Öffentlich schalten“. Alle Optionen stehen in `.env.example`.

Hinweis: Google schränkt Uploads aus nicht geprüften API-Projekten teilweise auf „privat“ ein. Ob das auch geplante Livestreams betrifft, beim ersten Test kontrollieren.
