// Lokales Web-Dashboard: Events ansehen, Thumbnails prüfen/anpassen, YouTube-Sichtbarkeit umschalten.
const http = require('http');
const fs = require('fs');
const path = require('path');
const sync = require('./sync');
const youtube = require('./youtube');
const canvas = require('./canvas');

const STATIC_DIR = path.join(__dirname, 'dashboard');
const STATIC_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 100 * 1024;

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

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, 'Anfrage zu groß'));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new HttpError(400, 'Ungültiges JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.host
 * @param {(eventId?: string) => Promise<object>} options.runSync Abgleich (mit Login) ausführen
 * @param {() => string[]} options.getLog letzte Log-Zeilen
 */
function start({ port, host, runSync, getLog }) {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `${host}:${port}`]);
    let lastError = null;
    let lastStats = null;

    const findEvent = id => {
        const event = sync.loadReport().events.find(e => e.id === id);
        if (!event) throw new HttpError(404, 'Event nicht gefunden – bitte neu abgleichen');
        return event;
    };

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
                backgrounds: canvas.listBackgrounds(),
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

        ['POST', /^\/api\/events\/(\d+)\/preview$/, async (req, res, [id]) => {
            const event = findEvent(id);
            if (!event.ctInfo) throw new HttpError(400, 'Für dieses Event gibt es keine Thumbnail-Daten');
            const body = await readBody(req);
            const info = sync.applyOverrides(event.ctInfo, body);
            send(res, 200, await sync.renderPreview(info), 'image/jpeg');
        }],

        ['PUT', /^\/api\/events\/(\d+)\/override$/, async (req, res, [id]) => {
            findEvent(id);
            const override = sync.saveOverride(id, await readBody(req));
            return { override, stats: await runAndRemember(id) };
        }],

        ['DELETE', /^\/api\/events\/(\d+)\/override$/, async (req, res, [id]) => {
            findEvent(id);
            sync.saveOverride(id, null);
            return { override: null, stats: await runAndRemember(id) };
        }],

        ['POST', /^\/api\/events\/(\d+)\/privacy$/, async (req, res, [id]) => {
            if (!youtube.isEnabled()) throw new HttpError(400, 'YouTube-Abgleich ist nicht aktiviert');
            const ytId = sync.loadState().events[id]?.youtube?.id;
            if (!ytId) throw new HttpError(404, 'Zu diesem Event gibt es keinen Livestream');
            const { privacy } = await readBody(req);
            if (!['public', 'unlisted', 'private'].includes(privacy)) throw new HttpError(400, 'Ungültige Sichtbarkeit');
            return { privacy: await youtube.setPrivacy(ytId, privacy) };
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
                const result = await handler(req, res, match.slice(1));
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
