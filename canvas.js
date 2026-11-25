const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, 'assets');
const WIDTH = 1920;
const HEIGHT = 1080;
const FONT_FAMILY = 'Ubuntu Bold';
// Erhöhen, wenn sich das Layout ändert -> alle Thumbnails werden beim nächsten Abgleich neu erzeugt
const RENDER_VERSION = 1;

// Alle Größen in px, abgemessen an assets/Thumbnail sample.jpg
const LAYOUT = {
    left: 127,
    date: { y: 220, size: 106, color: '#d621a5' },         // Pink
    event: { y: 350, size: 106, color: '#ffcc00' },        // Gelb
    subject: {
        x: 140, y: 742, size: 75, color: '#ffffff',        // Weiß
        lineHeight: 1.2, maxWidth: 1000, maxLines: 3, minSize: 55,
    },
};

registerFont(path.join(ASSETS, 'Ubuntu-Bold.ttf'), { family: FONT_FAMILY });

function font(sizePx) {
    return `${sizePx}px "${FONT_FAMILY}"`;
}

function selectBackground(eventType) {
    // Nur einfache Dateinamen zulassen (Art kann im Dashboard frei eingegeben werden)
    const file = eventType.toLowerCase().replace(/[^a-z0-9äöüß_-]/g, '') + '.png';
    const candidate = path.join(ASSETS, 'backgrounds', file);
    return fs.existsSync(candidate) ? candidate : path.join(ASSETS, 'backgrounds', 'default.png');
}

/** Alle Möglichkeiten, die Wörter auf genau n Zeilen zu verteilen. */
function* splits(words, n) {
    if (n === 1) { yield [words.join(' ')]; return; }
    for (let i = 1; i <= words.length - n + 1; i++) {
        for (const rest of splits(words.slice(i), n - 1)) yield [words.slice(0, i).join(' '), ...rest];
    }
}

/**
 * Bricht den Text möglichst ausgewogen um (wie im Sample: "Der letzte Wille / von Jesus: Einheit").
 * Wenn er auch auf maxLines nicht passt, wird die Schrift verkleinert.
 */
function wrapBalanced(ctx, text, { size, maxWidth, maxLines, minSize }) {
    // Manuelle Zeilenumbrüche (aus dem Dashboard) haben Vorrang; dann nur noch die Größe anpassen
    if (text.includes('\n')) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const manualMaxWidth = 1250; // etwas mehr Platz als beim Automatik-Umbruch, aber nicht bis ins Logo
        for (let s = size; s >= minSize; s -= 5) {
            ctx.font = font(s);
            if (Math.max(...lines.map(l => ctx.measureText(l).width)) <= manualMaxWidth) return { size: s, lines };
        }
        text = lines.join(' '); // passt nicht -> doch automatisch umbrechen
    }
    const words = text.split(/\s+/).filter(Boolean);
    for (let s = size; s >= minSize; s -= 5) {
        ctx.font = font(s);
        const width = line => ctx.measureText(line).width;
        if (width(text) <= maxWidth) return { size: s, lines: [text] };
        for (let n = 2; n <= Math.min(maxLines, words.length); n++) {
            let best = null;
            for (const lines of splits(words, n)) {
                const widest = Math.max(...lines.map(width));
                if (widest <= maxWidth && (!best || widest < best.widest)) best = { widest, lines };
            }
            if (best) return { size: s, lines: best.lines };
        }
    }
    ctx.font = font(minSize);
    return { size: minSize, lines: [text] }; // Notfall: zu lang, wird abgeschnitten
}

/** Schriftgröße so weit verkleinern, dass eine einzelne Zeile in maxWidth passt. */
function fitSingleLine(ctx, text, size, maxWidth) {
    let s = size;
    ctx.font = font(s);
    while (s > 30 && ctx.measureText(text).width > maxWidth) ctx.font = font(--s);
}

function writeText(ctx, { date, event, subject }) {
    ctx.save();
    ctx.shadowColor = 'rgba(30, 30, 30, 0.5)';
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 10;
    ctx.shadowBlur = 15;
    const headerMaxWidth = WIDTH - 2 * LAYOUT.left;

    fitSingleLine(ctx, date, LAYOUT.date.size, headerMaxWidth);
    ctx.fillStyle = LAYOUT.date.color;
    ctx.fillText(date, LAYOUT.left, LAYOUT.date.y);

    const eventText = event.toUpperCase();
    fitSingleLine(ctx, eventText, LAYOUT.event.size, headerMaxWidth);
    ctx.fillStyle = LAYOUT.event.color;
    ctx.fillText(eventText, LAYOUT.left, LAYOUT.event.y);

    if (subject) {
        const s = LAYOUT.subject;
        const { size, lines } = wrapBalanced(ctx, subject, s);
        ctx.font = font(size);
        ctx.fillStyle = s.color;
        const lineHeightPx = size * s.lineHeight;
        lines.forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lineHeightPx));
    }
    ctx.restore();
}

/** Verfügbare Hintergründe (Dateinamen ohne .png), z. B. für die Auswahl im Dashboard. */
function listBackgrounds() {
    return fs.readdirSync(path.join(ASSETS, 'backgrounds'))
        .filter(f => f.toLowerCase().endsWith('.png'))
        .map(f => f.slice(0, -4));
}

/**
 * Rendert ein Thumbnail als JPEG-Buffer.
 * @param {{date: string, event: string, subject?: string}} info
 */
async function render(info) {
    const thumbnail = createCanvas(WIDTH, HEIGHT);
    const ctx = thumbnail.getContext('2d');

    ctx.drawImage(await loadImage(selectBackground(info.event)), 0, 0, WIDTH, HEIGHT);
    ctx.drawImage(await loadImage(path.join(ASSETS, 'logo.png')), 0, 0, WIDTH, HEIGHT);
    writeText(ctx, info);
    return thumbnail.toBuffer('image/jpeg', { quality: 0.92 });
}

/** Rendert ein Thumbnail und schreibt es als JPEG nach outFile. */
async function create(info, outFile) {
    const buffer = await render(info);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, buffer);
    return outFile;
}

module.exports = { create, render, selectBackground, listBackgrounds, RENDER_VERSION };
