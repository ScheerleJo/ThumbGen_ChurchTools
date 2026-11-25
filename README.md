# ThumbGen_ChurchTools

Erstellt automatisch YouTube-Thumbnails (1920×1080) sowie Titel und Beschreibung für Livestream-Gottesdienste aus ChurchTools-Events.

## Einrichtung

```
npm install
cp .env.example .env   # Zugangsdaten eintragen
```

## Verwendung

```
npm run watch              # dauerhaft laufen, alle 15 min abgleichen
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

## Ideen / TODO

- Thumbnail direkt am geplanten YouTube-Livestream setzen (YouTube Data API `thumbnails.set`).
