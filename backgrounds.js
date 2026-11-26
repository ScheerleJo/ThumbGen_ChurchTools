// Hintergründe für Thumbnails: mitgelieferte (assets/backgrounds) und im Dashboard hochgeladene (data/backgrounds).
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const BUILTIN_DIR = path.join(__dirname, 'assets', 'backgrounds');
const UPLOAD_DIR = path.join(path.resolve(__dirname, process.env.DATA_DIR || 'data'), 'backgrounds');
const WIDTH = 1920;
const HEIGHT = 1080;
const MAX_NAME = 40;

/** Name -> erlaubter Dateiname (ohne .png); leer, wenn nichts übrig bleibt. */
function normalizeName(name) {
    return String(name || '').trim().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9äöüß_-]/g, '')
        .slice(0, MAX_NAME);
}

function list() {
    const read = (dir, builtin) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
        .filter(f => f.toLowerCase().endsWith('.png'))
        .map(f => ({ name: f.slice(0, -4), builtin, file: path.join(dir, f) }));
    const builtin = read(BUILTIN_DIR, true);
    const names = new Set(builtin.map(b => b.name));
    // Mitgelieferte haben Vorrang, falls es denselben Namen doch einmal doppelt gibt
    return [...builtin, ...read(UPLOAD_DIR, false).filter(b => !names.has(b.name))]
        .sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name, 'de')));
}

function find(name) {
    const clean = normalizeName(name);
    return clean ? list().find(b => b.name === clean) || null : null;
}

/**
 * Welcher Hintergrund wird verwendet?
 * 1. explizit gewählter (falls vorhanden), 2. passend zur Art des Gottesdienstes, 3. default
 * @returns {{name: string, file: string, auto: boolean}}
 */
function resolve(chosen, eventType) {
    const explicit = chosen && find(chosen);
    if (explicit) return { name: explicit.name, file: explicit.file, auto: false };
    const byType = find(String(eventType || '').replace(/\s+/g, ''));
    const fallback = byType || find('default');
    return { name: fallback.name, file: fallback.file, auto: true };
}

/**
 * Speichert ein hochgeladenes Bild als 1920x1080-PNG (zugeschnitten wie "cover").
 * @returns {Promise<{name: string, builtin: false, file: string}>}
 */
async function save(name, buffer) {
    const clean = normalizeName(name);
    if (!clean) throw Object.assign(new Error('Bitte einen Namen angeben (Buchstaben, Ziffern, - oder _)'), { status: 400 });
    if (list().some(b => b.builtin && b.name === clean)) {
        throw Object.assign(new Error(`„${clean}“ ist ein mitgelieferter Hintergrund – bitte einen anderen Namen wählen`), { status: 409 });
    }
    let image;
    try {
        image = await loadImage(buffer);
    } catch {
        throw Object.assign(new Error('Die Datei ist kein lesbares Bild (PNG oder JPEG)'), { status: 400 });
    }
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    const scale = Math.max(WIDTH / image.width, HEIGHT / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const file = path.join(UPLOAD_DIR, clean + '.png');
    fs.writeFileSync(file + '.tmp', canvas.toBuffer('image/png'));
    fs.renameSync(file + '.tmp', file);
    previewCache.delete(file);
    return { name: clean, builtin: false, file };
}

function remove(name) {
    const bg = find(name);
    if (!bg) throw Object.assign(new Error('Hintergrund nicht gefunden'), { status: 404 });
    if (bg.builtin) throw Object.assign(new Error('Mitgelieferte Hintergründe können nicht gelöscht werden'), { status: 400 });
    fs.rmSync(bg.file, { force: true });
    previewCache.delete(bg.file);
}

// Kleine Vorschaubilder für die Auswahl im Dashboard
const previewCache = new Map();
async function preview(name) {
    const bg = find(name);
    if (!bg) return null;
    const mtime = fs.statSync(bg.file).mtimeMs;
    const cached = previewCache.get(bg.file);
    if (cached?.mtime === mtime) return cached.buffer;
    const canvas = createCanvas(384, 216);
    canvas.getContext('2d').drawImage(await loadImage(bg.file), 0, 0, 384, 216);
    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
    previewCache.set(bg.file, { mtime, buffer });
    return buffer;
}

module.exports = { list, find, resolve, save, remove, preview, normalizeName, UPLOAD_DIR };
