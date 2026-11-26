// Lokales Web-Dashboard: Events ansehen, Thumbnails prüfen/anpassen, YouTube-Sichtbarkeit umschalten.
const http = require('http');
const fs = require('fs');
const path = require('path');
const sync = require('./sync');
const youtube = require('./youtube');
const backgrounds = require('./backgrounds');

const STATIC_DIR = path.join(__dirname, 'dashboard');
const STATIC_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 100 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(payload);
}

function readRaw(req, max) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > max) {
                reject(new HttpError(413, `Anfrage zu groß (max. ${Math.round(max / 1024 / 1024) || 0.1} MB)`));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readBody(req) {
    const raw = await readRaw(req, MAX_BODY);
    if (!raw.length) return {};
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch {
        throw new HttpError(400, 'Ungültiges JSON');
    }
}

const publicBackground = ({ name, builtin }) => ({ name, builtin });

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.host
 * @param {(eventId?: string) => Promise<object>} options.runSync Abgleich (mit Login) ausführen
 * @param {() => string[]} options.getLog letzte Log-Zeilen
 * @param {(msg: string) => void} [options.log] Log-Ausgabe
 */
function start({ port, host, runSync, getLog, log: logLine = console.log }) {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `${host}:${port}`]);
    let lastError = null;
    let lastStats = null;

    const findEvent = id => {
        const event = sync.loadReport().events.find(e => e.id === id);
        if (!event) throw new HttpError(404, 'Event nicht gefunden – bitte neu abgleichen');
        return event;
    };
    const findChurchToolsEvent = id => {
        if (sync.isManualId(id)) throw new HttpError(400, 'Manuell angelegte Streams werden direkt bearbeitet');
        return findEvent(id);
    };

    const removeManual = id => sync.removeManual(id, { log: logLine });

    const runAndRemember = async eventId => {
        try {
            lastStats = await runSync(eventId);
            lastError = null;
            return lastStats;
        } catch (err) {
            lastError = err.message;
            throw err;
        }
    };

    const routes = [
        ['GET', /^\/api\/status$/, async () => {
            const report = sync.loadReport();
            const yt = youtube.isEnabled();
            return {
                running: sync.isRunning(),
                lastSync: report.updatedAt && report.updatedAt > (report.generatedAt || '') ? report.updatedAt : report.generatedAt,
                range: report.from ? { from: report.from, to: report.to } : null,
                lastStats, lastError,
                youtube: yt ? { enabled: true, privacyDefault: youtube.settings().privacy } : { enabled: false },
                backgrounds: backgrounds.list().map(publicBackground),
                log: getLog().slice(-40),
            };
        }],

        ['GET', /^\/api\/events$/, async () => {
            const report = sync.loadReport();
            const overrides = sync.loadOverrides();
            const events = report.events.map(e => ({ ...e, override: overrides[e.id] || null }));
            let youtubeError = null;
            if (youtube.isEnabled()) {
                const ids = events.map(e => e.youtubeId).filter(Boolean);
                try {
                    const statuses = ids.length ? await youtube.getStatuses(ids) : {};
                    for (const e of events) {
                        if (!e.youtubeId) continue;
                        e.youtube = statuses[e.youtubeId] || { missing: true };
                        e.youtube.watchUrl = youtube.watchUrl(e.youtubeId);
                        e.youtube.studioUrl = youtube.studioUrl(e.youtubeId);
                    }
                } catch (err) {
                    youtubeError = err.message;
                }
            }
            return { generatedAt: report.generatedAt, events, youtubeError };
        }],

        ['GET', /^\/api\/thumbnail\/([^/]+)$/, async (req, res, [file]) => {
            const name = path.basename(decodeURIComponent(file));
            const full = path.join(sync.OUTPUT_DIR, name);
            if (!name.endsWith('.jpeg') || !fs.existsSync(full)) throw new HttpError(404, 'Thumbnail nicht gefunden');
            send(res, 200, fs.readFileSync(full), 'image/jpeg');
        }],

        ['POST', /^\/api\/sync$/, async () => ({ stats: await runAndRemember() })],

        ['POST', /^\/api\/events\/([\w-]+)\/preview$/, async (req, res, [id]) => {
            const event = findChurchToolsEvent(id);
            if (!event.ctInfo) throw new HttpError(400, 'Für dieses Event gibt es keine Thumbnail-Daten');
            const body = await readBody(req);
            const info = sync.applyOverrides(event.ctInfo, body);
            send(res, 200, await sync.renderPreview(info), 'image/jpeg');
        }],

        ['PUT', /^\/api\/events\/([\w-]+)\/override$/, async (req, res, [id]) => {
            findChurchToolsEvent(id);
            const override = sync.saveOverride(id, await readBody(req));
            return { override, stats: await runAndRemember(id) };
        }],

        ['DELETE', /^\/api\/events\/([\w-]+)\/override$/, async (req, res, [id]) => {
            findChurchToolsEvent(id);
            sync.saveOverride(id, null);
            return { override: null, stats: await runAndRemember(id) };
        }],

        ['POST', /^\/api\/events\/([\w-]+)\/privacy$/, async (req, res, [id]) => {
            if (!youtube.isEnabled()) throw new HttpError(400, 'YouTube-Abgleich ist nicht aktiviert');
            const ytId = sync.loadState().events[id]?.youtube?.id;
            if (!ytId) throw new HttpError(404, 'Zu diesem Event gibt es keinen Livestream');
            const { privacy } = await readBody(req);
            if (!['public', 'unlisted', 'private'].includes(privacy)) throw new HttpError(400, 'Ungültige Sichtbarkeit');
            return { privacy: await youtube.setPrivacy(ytId, privacy) };
        }],

        // ---- Manuell angelegte Streams ----
        ['POST', /^\/api\/preview$/, async (req, res) => {
            send(res, 200, await sync.renderPreview(sync.manualPreviewInfo(await readBody(req))), 'image/jpeg');
        }],

        ['POST', /^\/api\/manual$/, async req => {
            const id = sync.saveManual(null, await readBody(req));
            return { id, stats: await runAndRemember(id) };
        }],

        ['PUT', /^\/api\/manual\/([\w-]+)$/, async (req, res, [id]) => {
            sync.saveManual(id, await readBody(req));
            return { id, stats: await runAndRemember(id) };
        }],

        ['DELETE', /^\/api\/manual\/([\w-]+)$/, async (req, res, [id]) => ({ stats: await removeManual(id) })],

        // ---- Hintergründe ----
        ['GET', /^\/api\/backgrounds$/, async () => ({ backgrounds: backgrounds.list().map(publicBackground) })],

        ['GET', /^\/api\/backgrounds\/([^/]+)\/image$/, async (req, res, [name]) => {
            const image = await backgrounds.preview(decodeURIComponent(name));
            if (!image) throw new HttpError(404, 'Hintergrund nicht gefunden');
            send(res, 200, image, 'image/jpeg');
        }],

        ['POST', /^\/api\/backgrounds$/, async (req, res, match, url) => {
            if (!/^image\/(png|jpeg)$/.test(req.headers['content-type'] || '')) {
                throw new HttpError(415, 'Bitte ein PNG- oder JPEG-Bild hochladen');
            }
            const saved = await backgrounds.save(url.searchParams.get('name'), await readRaw(req, MAX_UPLOAD));
            return { background: publicBackground(saved) };
        }],

        ['DELETE', /^\/api\/backgrounds\/([^/]+)$/, async (req, res, [name]) => {
            const bg = backgrounds.find(decodeURIComponent(name));
            if (!bg) throw new HttpError(404, 'Hintergrund nicht gefunden');
            const usedBy = sync.backgroundUsage(bg.name);
            if (usedBy.length) throw new HttpError(409, `Wird noch verwendet: ${usedBy.join(', ')}`);
            backgrounds.remove(bg.name);
            return { deleted: bg.name };
        }],
    ];

    const server = http.createServer(async (req, res) => {
        try {
            // Schutz vor DNS-Rebinding und Cross-Site-Requests: nur lokaler Host, Änderungen nur mit eigenem Header
            if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Unerlaubter Host');
            if (req.method !== 'GET' && req.headers['x-thumbgen'] !== '1') throw new HttpError(403, 'Fehlender Header');

            const url = new URL(req.url, `http://${req.headers.host}`);
            if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
                const [file, type] = STATIC_FILES[url.pathname];
                return send(res, 200, fs.readFileSync(path.join(STATIC_DIR, file)), type);
            }
            for (const [method, pattern, handler] of routes) {
                const match = url.pathname.match(pattern);
                if (!match || method !== req.method) continue;
                const result = await handler(req, res, match.slice(1), url);
                if (!res.headersSent) send(res, 200, result ?? {});
                return;
            }
            throw new HttpError(404, 'Nicht gefunden');
        } catch (err) {
            if (res.headersSent) return res.end();
            send(res, err.status || 500, { error: err.message });
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}

module.exports = { start };
