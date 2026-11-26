// Abgleich ChurchTools -> output/: erstellt neue Thumbnails, aktualisiert geänderte, entfernt hinfällige.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Mustache = require('mustache');
const ct = require('./churchtools');
const canvas = require('./canvas');
const text = require('./text');
const youtube = require('./youtube');
const backgrounds = require('./backgrounds');

Mustache.escape = value => String(value); // Keine HTML-Escapes in YouTube-Texten

const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin';
const OUTPUT_DIR = path.resolve(__dirname, process.env.OUTPUT_DIR || 'output');
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const STATE_FILE = path.join(OUTPUT_DIR, '.state.json');
const REPORT_FILE = path.join(OUTPUT_DIR, '.report.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');
const MANUAL_FILE = path.join(DATA_DIR, 'manual-events.json');
const TEMPLATES_FILE = path.join(__dirname, 'assets', 'templates.json');

// Felder, die im Dashboard manuell überschrieben werden können
const OVERRIDE_TEXT_FIELDS = ['sermonSubject', 'eventName', 'preacher', 'scripture'];
// IDs von im Dashboard angelegten Streams (ChurchTools-IDs sind rein numerisch)
const MANUAL_PREFIX = 'm-';
const isManualId = id => String(id).startsWith(MANUAL_PREFIX);

class InputError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function ymd(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Erst in Temp-Datei schreiben, dann umbenennen: nie halb geschriebene Dateien
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(file + '.tmp', file);
}

const loadState = () => readJson(STATE_FILE, { events: {} });
const saveState = state => writeJson(STATE_FILE, state);
const loadReport = () => readJson(REPORT_FILE, { generatedAt: null, events: [] });
const loadOverrides = () => readJson(OVERRIDES_FILE, {});

/** Speichert die manuellen Anpassungen für ein Event; leere Werte werden entfernt, null löscht alle. */
function saveOverride(eventId, values) {
    const all = loadOverrides();
    const clean = {};
    for (const key of OVERRIDE_TEXT_FIELDS) {
        const value = typeof values?.[key] === 'string' ? values[key].replace(/\r\n/g, '\n').trim() : '';
        if (value) clean[key] = value;
    }
    if (values?.force === true) clean.force = true;
    const background = backgrounds.find(values?.background);
    if (background) clean.background = background.name;
    if (Object.keys(clean).length) all[eventId] = clean;
    else delete all[eventId];
    writeJson(OVERRIDES_FILE, all);
    return all[eventId] || null;
}

function dateInfo(startDate) {
    const start = new Date(startDate);
    return {
        isoDate: ymd(start),
        date: start.toLocaleDateString('de-DE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }),
        startTime: start.toLocaleTimeString('de-DE', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }),
    };
}

function formatEvent(event, agenda, sermonItemTitle) {
    const sermonItem = text.findSermonItem(agenda, sermonItemTitle);
    const { subject, scripture } = text.getSermonInfo(sermonItem, event);
    return {
        info: {
            ...dateInfo(event.startDate),
            eventName: text.selectEvent(event.name),
            sermonSubject: subject || '',
            preacher: text.getResponsiblePerson(sermonItem) || '',
            scripture: scripture || '',
        },
        sermonItem,
    };
}

/** CT-Werte + manuelle Anpassungen -> Werte, mit denen gerendert wird. */
function applyOverrides(info, override) {
    const result = { ...info };
    for (const key of OVERRIDE_TEXT_FIELDS) if (override?.[key]) result[key] = override[key];
    // Nur setzen, wenn gewählt: sonst bleibt der Fingerprint bestehender Thumbnails gleich
    if (override?.background) result.background = override.background;
    result.scriptureLink = text.bibleserverLink(result.scripture);
    return result;
}

// ---------- Im Dashboard angelegte Streams (ohne ChurchTools-Event) ----------

const loadManual = () => readJson(MANUAL_FILE, {});

/** Datum + Uhrzeit in TIMEZONE -> Date (UTC), auch über Sommer-/Winterzeit hinweg. */
function zonedToUtc(date, time) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const wanted = Date.UTC(y, m - 1, d, hh, mm);
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    let guess = wanted;
    for (let i = 0; i < 3; i++) {
        const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(p => [p.type, Number(p.value)]));
        const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        if (shown === wanted) break;
        guess += wanted - shown;
    }
    return new Date(guess);
}

const str = (values, key) => (typeof values?.[key] === 'string' ? values[key].replace(/\r\n/g, '\n').trim() : '');

/** Werte eines manuellen Streams -> Render-Infos (gleiche Form wie bei ChurchTools-Events). */
function manualInfo(record) {
    const info = {
        ...dateInfo(record.startDate),
        eventName: record.eventName || 'Gottesdienst',
        sermonSubject: record.sermonSubject || '',
        preacher: record.preacher || '',
        scripture: record.scripture || '',
    };
    if (record.background) info.background = record.background;
    info.scriptureLink = text.bibleserverLink(info.scripture);
    return info;
}

/** Formularwerte -> Datensatz eines manuellen Streams. Ohne strict keine Prüfung (für die Vorschau). */
function manualRecord(values, { strict = true } = {}) {
    let date = str(values, 'date');
    let time = str(values, 'time');
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time);
    if (strict && !valid) throw new InputError('Bitte Datum und Uhrzeit angeben');
    if (!valid) {
        date = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ymd(new Date());
        time = /^\d{2}:\d{2}$/.test(time) ? time : '10:00';
    }
    const start = zonedToUtc(date, time);
    if (Number.isNaN(start.getTime())) throw new InputError('Ungültiges Datum');
    if (strict && start <= new Date()) throw new InputError('Der Termin muss in der Zukunft liegen');
    const record = {
        startDate: start.toISOString(),
        eventName: str(values, 'eventName') || 'Gottesdienst',
        sermonSubject: str(values, 'sermonSubject'),
        preacher: str(values, 'preacher'),
        scripture: str(values, 'scripture'),
        note: str(values, 'note'),
    };
    const background = backgrounds.find(values?.background);
    if (background) record.background = background.name;
    return record;
}

/** Legt einen Stream an (id = null) oder ändert ihn. Gibt die ID zurück; der Abgleich passiert danach. */
function saveManual(id, values) {
    const all = loadManual();
    if (id && !all[id]) throw new InputError('Stream nicht gefunden', 404);
    const newId = id || MANUAL_PREFIX + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    all[newId] = { ...manualRecord(values), createdAt: all[newId]?.createdAt || new Date().toISOString() };
    writeJson(MANUAL_FILE, all);
    return newId;
}

const manualPreviewInfo = values => manualInfo(manualRecord(values, { strict: false }));

const safeFileName =name => name.replace(/[\\/:*?"<>|\n\r]+/g, '').trim() || 'Gottesdienst';

/** Thumbnail-Pfad, Titel und Beschreibung für ein formatiertes Event. */
function buildOutput(info, suffix = '') {
    const templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    // Manuelle Zeilenumbrüche gibt es nur im Thumbnail, nicht in Titel/Beschreibung
    const view = { ...info, sermonSubject: info.sermonSubject.replace(/\s*\n\s*/g, ' '), eventDate: info.date };
    // suffix: z. B. die ID manueller Streams, damit sie nie mit einem ChurchTools-Event zur selben Zeit kollidieren
    const base = path.join(OUTPUT_DIR, `${info.isoDate}_${info.startTime.replace(':', '')}_${safeFileName(info.eventName)}${suffix}`);
    return {
        image: base + '.jpeg',
        textFile: base + '.txt',
        title: Mustache.render(templates.title, view),
        description: Mustache.render(templates.description, view),
    };
}

/** Ändert sich irgendetwas, das ins Ergebnis einfließt, ändert sich der Fingerprint. */
function fingerprint(info, output) {
    const background = backgrounds.resolve(info.background, info.eventName).file;
    const inputs = {
        info, title: output.title, description: output.description,
        background, backgroundMtime: fs.statSync(background).mtimeMs,
        renderer: canvas.RENDER_VERSION,
    };
    return crypto.createHash('sha1').update(JSON.stringify(inputs)).digest('hex');
}

const thumbnailInfo = info => ({ date: info.date, event: info.eventName, subject: info.sermonSubject, background: info.background });

async function writeOutput(info, output) {
    await canvas.create(thumbnailInfo(info), output.image);
    fs.writeFileSync(output.textFile, `${output.title}\n\n${output.description}\n`, 'utf8');
}

/** Rendert ein Thumbnail nur in den Speicher (Vorschau im Dashboard). */
function renderPreview(info) {
    return canvas.render(thumbnailInfo(info));
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

// Immer nur ein Abgleich gleichzeitig (Watch-Timer und Dashboard teilen sich State-Dateien)
let lockChain = Promise.resolve();
let running = false;
function withLock(fn) {
    const run = lockChain.then(async () => {
        running = true;
        try { return await fn(); } finally { running = false; }
    });
    lockChain = run.catch(() => {});
    return run;
}

const emptyStats = () => ({ created: 0, updated: 0, removed: 0, unchanged: 0, skipped: 0, failed: 0, youtube: 0 });

/** Entfernt ein verfolgtes Event: Dateien, State-Eintrag und (falls noch nicht live) den YouTube-Livestream. */
async function removeTracked(state, id, reason, label, { dryRun, log, stats }) {
    const entry = state.events[id];
    if (!entry) return false;
    log(`- ${label}: ${reason} – entferne ${entry.files.map(rel).join(', ')}`);
    if (entry.youtube?.id) {
        if (!youtube.isEnabled()) {
            log(`  YouTube-Livestream ${youtube.watchUrl(entry.youtube.id)} bleibt bestehen (YouTube-Abgleich ist aus)`);
        } else if (dryRun) {
            log(`  würde YouTube-Livestream ${youtube.watchUrl(entry.youtube.id)} löschen`);
        } else {
            // Schlägt das fehl, bleibt der Eintrag erhalten und es wird beim nächsten Lauf erneut versucht
            const result = await youtube.deleteBroadcast(entry.youtube.id);
            if (result === 'deleted') log(`  YouTube-Livestream ${youtube.watchUrl(entry.youtube.id)} gelöscht`);
            else if (result !== 'gone') log(`  YouTube-Livestream ${youtube.watchUrl(entry.youtube.id)} nicht gelöscht (Status: ${result})`);
            stats.youtube++;
        }
    }
    if (!dryRun) {
        removeFiles(entry.files);
        delete state.events[id];
    }
    stats.removed++;
    return true;
}

/**
 * Ein kompletter Abgleich (ChurchTools-Events + im Dashboard angelegte Streams).
 * Schreibt zusätzlich output/.report.json für das Dashboard.
 * @returns {Promise<{created: number, updated: number, removed: number, unchanged: number, skipped: number, failed: number, youtube: number}>}
 */
function syncOnce(options) {
    return withLock(() => doSync(options));
}

async function doSync({ days = 7, eventId, dryRun = false, force = false, rebuild = false, sermonItemTitle, log = console.log }) {
    const stats = emptyStats();
    const yt = youtube.isEnabled();
    const state = loadState();
    const overrides = loadOverrides();
    const manual = loadManual();
    const reportEntries = [];
    const now = new Date();
    const from = ymd(now);
    const to = ymd(addDays(now, days));

    let events = [];
    let manualIds = [];
    if (eventId && isManualId(eventId)) {
        manualIds = manual[eventId] ? [eventId] : [];
    } else if (eventId) {
        events = [await ct.getEvent(eventId)];
    } else {
        log(`Prüfe Events von ${from} bis ${to} ...`);
        events = (await ct.getEvents(from, to)) || [];
        // Manuelle Streams immer, auch wenn sie weiter in der Zukunft liegen
        manualIds = Object.keys(manual);
    }

    // Vergangene manuelle Streams nicht mehr verfolgen
    const pastManual = manualIds.filter(id => ymd(new Date(manual[id].startDate)) < from);
    if (pastManual.length) {
        manualIds = manualIds.filter(id => !pastManual.includes(id));
        if (!dryRun) {
            pastManual.forEach(id => delete manual[id]);
            writeJson(MANUAL_FILE, manual);
        }
    }

    const candidates = [
        ...events.map(event => ({
            id: String(event.id), event, name: event.name, startDate: event.startDate,
        })),
        ...manualIds.map(id => ({
            id, record: manual[id], name: manual[id].eventName, startDate: manual[id].startDate,
        })),
    ];

    for (const { id, event, record, name, startDate } of candidates) {
        const isManual = Boolean(record);
        const label = `${name} (#${id}, ${startDate})`;
        const override = isManual ? null : overrides[id] || null;
        const report = {
            id, manual: isManual, name, startDate, note: (isManual ? record.note : event.note) || '',
            canceled: !isManual && Boolean(event.isCanceled), streamed: isManual || text.isStreamed(event),
            agenda: null, sermonItem: null, ctInfo: null, info: null, override, background: null,
            problems: [], status: null, message: '', title: '', description: '',
        };
        reportEntries.push(report);
        const problems = report.problems;
        try {
            let info;
            if (isManual) {
                info = manualInfo(record);
                Object.assign(report, { ctInfo: info, info });
                if (!info.sermonSubject) problems.push('kein Thema angegeben');
            } else {
                if (event.isCanceled || !report.streamed) {
                    report.status = event.isCanceled ? 'abgesagt' : 'kein Livestream';
                    if (!(await removeTracked(state, id, report.status, label, { dryRun, log, stats }))) stats.skipped++;
                    continue;
                }

                const agenda = await ct.getEventAgenda(event.id);
                const { info: ctInfo, sermonItem } = formatEvent(event, agenda, sermonItemTitle);
                info = applyOverrides(ctInfo, override);
                Object.assign(report, {
                    agenda: agenda ? (agenda.isFinal ? 'abgeschlossen' : 'offen') : 'keine',
                    sermonItem: sermonItem ? {
                        title: sermonItem.title || '', note: sermonItem.note || '',
                        responsible: sermonItem.responsible?.text || '',
                    } : null,
                    ctInfo, info,
                });
                if (!agenda) problems.push('keine Agenda');
                else if (!agenda.isFinal) problems.push('Agenda nicht abgeschlossen');
                if (!info.sermonSubject) problems.push('kein Thema gefunden');
            }

            const bg = backgrounds.resolve(info.background, info.eventName);
            report.background = { name: bg.name, auto: bg.auto };
            const entry = state.events[id];
            const output = buildOutput(info, isManual ? `_${id}` : '');
            report.title = output.title;
            report.description = output.description;
            // Manuelle Streams werden immer erzeugt – dort gibt es keine Agenda, auf die man warten könnte
            if (problems.length && !(force || override?.force || isManual)) {
                // Ein vorhandenes Thumbnail bleibt stehen, bis die Agenda wieder fertig ist
                log(`  ${label}: ${problems.join(', ')} – ${entry ? 'behalte bisheriges Thumbnail' : 'übersprungen'}`);
                report.status = entry ? 'unverändert' : 'übersprungen';
                report.message = problems.join(', ');
                stats.skipped++;
                continue;
            }

            const fp = fingerprint(info, output);
            const files = [output.image, output.textFile];
            const filesExist = files.every(f => fs.existsSync(f));
            const localDone = entry && entry.fingerprint === fp && filesExist && !rebuild;
            const ytDone = !yt || (entry?.youtube?.fingerprint === fp
                && (entry.youtube.streamId ?? '') === youtube.settings().streamId && !rebuild);
            if (localDone && ytDone) {
                report.status = 'unverändert';
                stats.unchanged++;
                continue;
            }

            const current = { ...entry, startDate, name };
            if (!localDone) {
                const action = entry ? 'aktualisiert' : 'neu';
                log(`+ ${label}: ${action}${problems.length ? ' [WARNUNG: ' + problems.join(', ') + ']' : ''}`);
                log(`  -> ${rel(output.image)} | ${output.title}`);
                if (!dryRun) {
                    await writeOutput(info, output);
                    if (entry) removeFiles(entry.files, files); // z. B. alte Datei nach Terminverschiebung
                    Object.assign(current, { fingerprint: fp, files });
                    state.events[id] = current;
                }
                report.status = action;
                entry ? stats.updated++ : stats.created++;
            } else {
                report.status = 'unverändert';
                stats.unchanged++;
            }

            if (!ytDone) {
                const existingId = entry?.youtube?.id;
                if (new Date(startDate) <= now) {
                    log(`  YouTube: ${label} hat schon begonnen – Livestream wird nicht mehr geändert`);
                } else if (dryRun) {
                    log(`  würde YouTube-Livestream ${existingId ? 'aktualisieren' : 'anlegen'}`);
                } else {
                    const { id: ytId, created, streamId } = await youtube.upsertBroadcast(existingId, {
                        title: output.title,
                        description: output.description,
                        startTime: startDate,
                        thumbnail: output.image,
                    });
                    log(`  YouTube: Livestream ${created ? 'angelegt' : 'aktualisiert'} – ${youtube.watchUrl(ytId)}`);
                    current.youtube = { id: ytId, fingerprint: fp, streamId };
                    state.events[id] = current;
                    stats.youtube++;
                }
            }
        } catch (err) {
            log(`! ${label}: ${err.message}`);
            report.status = 'fehler';
            report.message = err.message;
            stats.failed++;
        }
    }

    if (!eventId) {
        const seen = new Set(candidates.map(c => c.id));
        for (const [id, entry] of Object.entries(state.events)) {
            const day = ymd(new Date(entry.startDate));
            if (day < from) {
                delete state.events[id]; // Vergangen: Dateien bleiben liegen, wird nur nicht mehr verfolgt
            } else if ((day <= to || isManualId(id)) && !seen.has(id)) {
                const reason = isManualId(id) ? 'Stream wurde gelöscht' : 'nicht mehr in ChurchTools (gelöscht oder verschoben)';
                try {
                    await removeTracked(state, id, reason, `${entry.name} (#${id})`, { dryRun, log, stats });
                } catch (err) {
                    log(`! ${entry.name} (#${id}): ${err.message}`);
                    stats.failed++;
                }
            }
        }
    }

    if (!dryRun) {
        saveState(state);
        // Thumbnail-/YouTube-Infos aus dem State ergänzen und Report schreiben
        for (const r of reportEntries) {
            const entry = state.events[r.id];
            r.thumbnail = entry?.files?.[0] && fs.existsSync(entry.files[0]) ? path.basename(entry.files[0]) : null;
            r.fingerprint = entry?.fingerprint || null;
            r.youtubeId = entry?.youtube?.id || null;
        }
        const previous = loadReport();
        const merged = eventId
            ? { ...previous, events: [...previous.events.filter(e => !reportEntries.some(r => r.id === e.id)), ...reportEntries] }
            : { generatedAt: now.toISOString(), from, to, events: reportEntries };
        merged.events.sort((a, b) => a.startDate.localeCompare(b.startDate));
        if (eventId) merged.updatedAt = now.toISOString();
        writeJson(REPORT_FILE, merged);
    }
    return stats;
}

/** Löscht einen im Dashboard angelegten Stream samt Thumbnail und (falls noch nicht live) YouTube-Livestream. */
function removeManual(id, { log = console.log } = {}) {
    return withLock(async () => {
        const manual = loadManual();
        if (!manual[id]) throw new InputError('Stream nicht gefunden', 404);
        const state = loadState();
        const stats = emptyStats();
        await removeTracked(state, id, 'im Dashboard gelöscht', `${manual[id].eventName} (#${id})`, { dryRun: false, log, stats });
        saveState(state);
        delete manual[id];
        writeJson(MANUAL_FILE, manual);
        const report = loadReport();
        report.events = report.events.filter(e => e.id !== id);
        writeJson(REPORT_FILE, report);
        return stats;
    });
}

/** Wird ein Hintergrund noch von einer Anpassung oder einem manuellen Stream verwendet? */
function backgroundUsage(name) {
    const report = loadReport();
    const label = id => {
        const e = report.events.find(ev => ev.id === id);
        return e ? `${e.name} am ${new Date(e.startDate).toLocaleDateString('de-DE', { timeZone: TIMEZONE })}` : `#${id}`;
    };
    return [
        ...Object.entries(loadOverrides()).filter(([, o]) => o.background === name).map(([id]) => label(id)),
        ...Object.entries(loadManual()).filter(([, m]) => m.background === name).map(([id]) => label(id)),
    ];
}

const isRunning = () => running;

module.exports = {
    syncOnce, buildOutput, writeOutput, renderPreview, applyOverrides,
    loadReport, loadState, loadOverrides, saveOverride, isRunning, OUTPUT_DIR,
    loadManual, saveManual, removeManual, manualPreviewInfo, isManualId, backgroundUsage,
};
