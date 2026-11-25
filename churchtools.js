const { churchtoolsClient, activateLogging } = require('@churchtools/churchtools-client');
const axiosCookieJarSupport = require('axios-cookiejar-support');
const tough = require('tough-cookie');

function init({ baseUrl, verbose }) {
    if (!baseUrl) throw new Error('CT_BASE_URL fehlt in der .env');
    churchtoolsClient.setCookieJar(axiosCookieJarSupport.wrapper, new tough.CookieJar());
    churchtoolsClient.setBaseUrl(baseUrl);
    if (verbose) activateLogging();
}

async function login({ loginToken, username, password }) {
    if (loginToken) {
        await churchtoolsClient.loginWithToken(loginToken);
        return;
    }
    if (!username || !password) {
        throw new Error('Keine Zugangsdaten: CT_LOGIN_TOKEN oder CT_USERNAME + CT_PASSWORD in der .env setzen');
    }
    // Der Client entpackt die Antwort bereits ({ data: {...} } -> {...})
    const result = await churchtoolsClient.post('/login', { username, password });
    if (result?.status !== 'success') {
        throw new Error('Login fehlgeschlagen: ' + (result?.message || JSON.stringify(result)));
    }
}

/** from/to als 'YYYY-MM-DD' */
async function getEvents(from, to) {
    return churchtoolsClient.get('/events', { from, to });
}

async function getEvent(eventId) {
    return churchtoolsClient.get(`/events/${eventId}`);
}

/** Liefert die Agenda oder null, wenn das Event keine hat. */
async function getEventAgenda(eventId) {
    try {
        return await churchtoolsClient.get(`/events/${eventId}/agenda`);
    } catch (err) {
        const status = err?.response?.status;
        if (status === 404) return null;
        throw err;
    }
}

module.exports = { init, login, getEvents, getEvent, getEventAgenda };
