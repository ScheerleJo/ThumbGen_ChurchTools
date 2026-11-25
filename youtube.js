// YouTube Data API: geplante Livestreams anlegen/aktualisieren/löschen und Thumbnails setzen.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const { OAuth2Client } = require('google-auth-library');
const { youtube: createYoutube } = require('@googleapis/youtube');

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
const CLIENT_SECRET_FILE = path.resolve(__dirname, process.env.YOUTUBE_CLIENT_SECRET_FILE || 'youtube-client-secret.json');
const TOKEN_FILE = path.resolve(__dirname, process.env.YOUTUBE_TOKEN_FILE || 'youtube-token.json');

// Nur noch nicht gestartete Broadcasts dürfen automatisch gelöscht werden
const DELETABLE_STATES = ['created', 'ready'];

function isEnabled() {
    return /^(1|true|ja|yes)$/i.test(process.env.YOUTUBE_ENABLED || '');
}

function settings() {
    const bool = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|ja|yes)$/i.test(value));
    const privacy = (process.env.YOUTUBE_PRIVACY || 'unlisted').toLowerCase();
    if (!['public', 'unlisted', 'private'].includes(privacy)) throw new Error(`YOUTUBE_PRIVACY ungültig: ${privacy}`);
    return {
        privacy,
        streamId: process.env.YOUTUBE_STREAM_ID || '',
        autoStart: bool(process.env.YOUTUBE_AUTO_START, true),
        autoStop: bool(process.env.YOUTUBE_AUTO_STOP, true),
    };
}

function readClientSecret() {
    if (!fs.existsSync(CLIENT_SECRET_FILE)) {
        throw new Error(`OAuth-Client-Datei fehlt: ${CLIENT_SECRET_FILE} (siehe README, Abschnitt YouTube)`);
    }
    const json = JSON.parse(fs.readFileSync(CLIENT_SECRET_FILE, 'utf8'));
    const cfg = json.installed || json.web;
    if (!cfg) throw new Error('OAuth-Client-Datei hat ein unbekanntes Format (erwartet: Desktop-App)');
    return cfg;
}

function saveToken(tokens) {
    const previous = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : {};
    // Google schickt den Refresh-Token nur beim ersten Mal mit – nicht überschreiben
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...previous, ...tokens }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

let cachedApi = null;

function api() {
    if (cachedApi) return cachedApi;
    const cfg = readClientSecret();
    if (!fs.existsSync(TOKEN_FILE)) {
        throw new Error('YouTube ist noch nicht autorisiert: einmal `node index.js --youtube-auth` ausführen');
    }
    const auth = new OAuth2Client({ clientId: cfg.client_id, clientSecret: cfg.client_secret });
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
    auth.on('tokens', saveToken);
    cachedApi = createYoutube({ version: 'v3', auth });
    return cachedApi;
}

/** Einmalige Anmeldung im Browser; speichert den Refresh-Token in TOKEN_FILE. */
async function authorize() {
    const cfg = readClientSecret();
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const auth = new OAuth2Client({ clientId: cfg.client_id, clientSecret: cfg.client_secret, redirectUri });
    const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
    const url = auth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // sorgt dafür, dass ein Refresh-Token ausgestellt wird
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
    });

    console.log('Bitte diese Adresse im Browser öffnen und mit dem Konto anmelden, das den YouTube-Kanal verwaltet:\n');
    console.log(url + '\n');
    console.log('Warte auf die Anmeldung ...');

    const code = await new Promise((resolve, reject) => {
        server.on('request', (req, res) => {
            const params = new URL(req.url, redirectUri).searchParams;
            if (!params.has('code') && !params.has('error')) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            if (params.get('error')) {
                res.end('Anmeldung abgebrochen. Das Fenster kann geschlossen werden.');
                reject(new Error('Anmeldung abgebrochen: ' + params.get('error')));
            } else {
                res.end('Anmeldung erfolgreich. Das Fenster kann geschlossen werden.');
                resolve(params.get('code'));
            }
        });
    }).finally(() => server.close());

    const { tokens } = await auth.getToken({ code, codeVerifier });
    if (!tokens.refresh_token) throw new Error('Google hat keinen Refresh-Token geliefert – bitte erneut versuchen');
    saveToken(tokens);
    console.log(`Gespeichert in ${TOKEN_FILE}`);
}

/** Streams (Stream-Keys) des Kanals, um YOUTUBE_STREAM_ID zu finden. Der Key selbst wird nicht ausgegeben. */
async function listStreams() {
    const res = await api().liveStreams.list({ part: ['id', 'snippet', 'cdn'], mine: true, maxResults: 50 });
    return (res.data.items || []).map(s => ({
        id: s.id,
        title: s.snippet?.title,
        resolution: s.cdn?.resolution,
        frameRate: s.cdn?.frameRate,
    }));
}

// YouTube lehnt < und > in Titel/Beschreibung ab; Titel max. 100, Beschreibung max. 5000 Zeichen
function clean(value, max) {
    const textValue = String(value || '').replace(/[<>]/g, '');
    return textValue.length > max ? textValue.slice(0, max - 1).trimEnd() + '…' : textValue;
}

function isNotFound(err) {
    return err?.code === 404 || err?.status === 404 || err?.response?.status === 404;
}

async function getBroadcast(id) {
    const res = await api().liveBroadcasts.list({ part: ['id', 'status'], id: [id] });
    return res.data.items?.[0] || null;
}

async function insertBroadcast({ title, description, startTime }) {
    const s = settings();
    const res = await api().liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'],
        requestBody: {
            snippet: { title: clean(title, 100), description: clean(description, 5000), scheduledStartTime: startTime },
            status: { privacyStatus: s.privacy, selfDeclaredMadeForKids: false },
            contentDetails: { enableAutoStart: s.autoStart, enableAutoStop: s.autoStop },
        },
    });
    const id = res.data.id;
    if (s.streamId) {
        await api().liveBroadcasts.bind({ id, streamId: s.streamId, part: ['id'] });
    }
    return id;
}

async function updateBroadcast(id, { title, description, startTime }) {
    // Nur "snippet" aktualisieren: Sichtbarkeit und Einstellungen, die im Studio geändert wurden, bleiben erhalten
    await api().liveBroadcasts.update({
        part: ['snippet'],
        requestBody: {
            id,
            snippet: { title: clean(title, 100), description: clean(description, 5000), scheduledStartTime: startTime },
        },
    });
}

/**
 * Legt den Broadcast an oder aktualisiert ihn und setzt das Thumbnail.
 * @returns {Promise<{id: string, created: boolean}>}
 */
async function upsertBroadcast(existingId, { title, description, startTime, thumbnail }) {
    let id = existingId;
    let created = false;
    if (id) {
        try {
            await updateBroadcast(id, { title, description, startTime });
            // Falls YOUTUBE_STREAM_ID geändert wurde: auf den aktuellen Stream-Key umbinden
            const { streamId } = settings();
            if (streamId) await api().liveBroadcasts.bind({ id, streamId, part: ['id'] });
        } catch (err) {
            if (!isNotFound(err)) throw err;
            id = null; // Im Studio gelöscht -> neu anlegen
        }
    }
    if (!id) {
        id = await insertBroadcast({ title, description, startTime });
        created = true;
    }
    await api().thumbnails.set({
        videoId: id,
        // Sofort komplett einlesen statt lazy zu streamen: kein offener Datei-Handle, falls der Request scheitert
        media: { mimeType: 'image/jpeg', body: Readable.from(fs.readFileSync(thumbnail)) },
    });
    return { id, created, streamId: settings().streamId };
}

/**
 * Löscht einen Broadcast, sofern er noch nicht live war.
 * @returns {Promise<'deleted'|'gone'|string>} 'deleted', 'gone' (existiert nicht mehr) oder der Status, wegen dem nicht gelöscht wurde
 */
async function deleteBroadcast(id) {
    const broadcast = await getBroadcast(id);
    if (!broadcast) return 'gone';
    const status = broadcast.status?.lifeCycleStatus;
    if (!DELETABLE_STATES.includes(status)) return status;
    await api().liveBroadcasts.delete({ id });
    return 'deleted';
}

function watchUrl(id) {
    return `https://youtu.be/${id}`;
}

module.exports = { isEnabled, settings, authorize, listStreams, upsertBroadcast, deleteBroadcast, watchUrl, api };
