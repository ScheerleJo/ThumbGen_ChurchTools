// Abgleich ChurchTools -> output/: erstellt neue Thumbnails, aktualisiert geänderte, entfernt hinfällige.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Mustache = require('mustache');
const ct = require('./churchtools');
const canvas = require('./canvas');
const text = require('./text');

Mustache.escape = value => String(value); // Keine HTML-Escapes in YouTube-Texten

const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin';
const OUTPUT_DIR = path.resolve(__dirname, process.env.OUTPUT_DIR || 'output');
const STATE_FILE = path.join(OUTPUT_DIR, '.state.json');
const TEMPLATES_FILE = path.join(__dirname, 'assets', 'templates.json');

function ymd(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { events: {} };
    }
}

function saveState(state) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function formatEvent(event, agenda, sermonItemTitle) {
    const start = new Date(event.startDate);
    const sermonItem = text.findSermonItem(agenda, sermonItemTitle);
    const { subject, scripture } = text.getSermonInfo(sermonItem, event);
    return {
        isoDate: ymd(start),
        date: start.toLocaleDateString('de-DE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }),
        startTime: start.toLocaleTimeString('de-DE', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }),
        eventName: text.selectEvent(event.name),
        sermonSubject: subject || '',
        preacher: text.getResponsiblePerson(sermonItem) || '',
        scripture: scripture || '',
        scriptureLink: text.bibleserverLink(scripture),
    };
}

/** Thumbnail-Pfad, Titel und Beschreibung für ein formatiertes Event. */
function buildOutput(info) {
    const templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    const view = { ...info, eventDate: info.date };
    const base = path.join(OUTPUT_DIR, `${info.isoDate}_${info.startTime.replace(':', '')}_${info.eventName}`);
    return {
        image: base + '.jpeg',
        textFile: base + '.txt',
        title: Mustache.render(templates.title, view),
        description: Mustache.render(templates.description, view),
    };
}

/** Ändert sich irgendetwas, das ins Ergebnis einfließt, ändert sich der Fingerprint. */
function fingerprint(info, output) {
    const background = canvas.selectBackground(info.eventName);
    const inputs = {
        info, title: output.title, description: output.description,
        background, backgroundMtime: fs.statSync(background).mtimeMs,
        renderer: canvas.RENDER_VERSION,
    };
    return crypto.createHash('sha1').update(JSON.stringify(inputs)).digest('hex');
}

async function writeOutput(info, output) {
    await canvas.create({ date: info.date, event: info.eventName, subject: info.sermonSubject }, output.image);
    fs.writeFileSync(output.textFile, `${output.title}\n\n${output.description}\n`, 'utf8');
}

function removeFiles(files, keep = []) {
    for (const file of files || []) {
        if (keep.includes(file)) continue;
        // Nur eigene Dateien im Output-Ordner löschen
        if (path.dirname(path.resolve(file)) !== OUTPUT_DIR) continue;
        fs.rmSync(file, { force: true });
    }
}

const rel = file => path.relative(process.cwd(), file);

/**
 * Ein kompletter Abgleich.
 * @returns {{created: number, updated: number, removed: number, unchanged: number, skipped: number, failed: number}}
 */
async function syncOnce({ days = 7, eventId, dryRun = false, force = false, rebuild = false, sermonItemTitle, log = console.log }) {
    const stats = { created: 0, updated: 0, removed: 0, unchanged: 0, skipped: 0, failed: 0 };
    const state = loadState();
    const now = new Date();
    const from = ymd(now);
    const to = ymd(addDays(now, days));

    let events;
    if (eventId) {
        events = [await ct.getEvent(eventId)];
    } else {
        log(`Prüfe Events von ${from} bis ${to} ...`);
        events = (await ct.getEvents(from, to)) || [];
    }

    const remove = (id, reason, label) => {
        const entry = state.events[id];
        if (!entry) return false;
        log(`- ${label}: ${reason} – entferne ${entry.files.map(rel).join(', ')}`);
        if (!dryRun) removeFiles(entry.files);
        delete state.events[id];
        stats.removed++;
        return true;
    };

    for (const event of events) {
        const id = String(event.id);
        const label = `${event.name} (#${event.id}, ${event.startDate})`;
        try {
            if (event.isCanceled || !text.isStreamed(event)) {
                const reason = event.isCanceled ? 'abgesagt' : 'kein Livestream';
                if (!remove(id, reason, label)) stats.skipped++;
                continue;
            }

            const agenda = await ct.getEventAgenda(event.id);
            const info = formatEvent(event, agenda, sermonItemTitle);
            const problems = [];
            if (!agenda) problems.push('keine Agenda');
            else if (!agenda.isFinal) problems.push('Agenda nicht abgeschlossen');
            if (!info.sermonSubject) problems.push('kein Thema gefunden');

            const entry = state.events[id];
            if (problems.length && !force) {
                // Ein vorhandenes Thumbnail bleibt stehen, bis die Agenda wieder fertig ist
                log(`  ${label}: ${problems.join(', ')} – ${entry ? 'behalte bisheriges Thumbnail' : 'übersprungen'}`);
                stats.skipped++;
                continue;
            }

            const output = buildOutput(info);
            const fp = fingerprint(info, output);
            const files = [output.image, output.textFile];
            const filesExist = files.every(f => fs.existsSync(f));
            if (entry && entry.fingerprint === fp && filesExist && !rebuild) {
                stats.unchanged++;
                continue;
            }

            const action = entry ? 'aktualisiert' : 'neu';
            log(`+ ${label}: ${action}${problems.length ? ' [WARNUNG: ' + problems.join(', ') + ']' : ''}`);
            log(`  -> ${rel(output.image)} | ${output.title}`);
            if (!dryRun) {
                await writeOutput(info, output);
                if (entry) removeFiles(entry.files, files); // z. B. alte Datei nach Terminverschiebung
                state.events[id] = { fingerprint: fp, files, startDate: event.startDate, name: event.name };
            }
            entry ? stats.updated++ : stats.created++;
        } catch (err) {
            log(`! ${label}: ${err.message}`);
            stats.failed++;
        }
    }

    if (!eventId) {
        const seen = new Set(events.map(e => String(e.id)));
        for (const [id, entry] of Object.entries(state.events)) {
            const day = ymd(new Date(entry.startDate));
            if (day < from) {
                delete state.events[id]; // Vergangen: Dateien bleiben liegen, wird nur nicht mehr verfolgt
            } else if (day <= to && !seen.has(id)) {
                remove(id, 'nicht mehr in ChurchTools (gelöscht oder verschoben)', `${entry.name} (#${id})`);
            }
        }
    }

    if (!dryRun) saveState(state);
    return stats;
}

module.exports = { syncOnce, buildOutput, writeOutput, OUTPUT_DIR };
