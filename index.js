const { churchtoolsClient, activateLogging } = require('@churchtools/churchtools-client');
const axiosCookieJarSupport = require('axios-cookiejar-support');
const tough = require('tough-cookie');
require('dotenv').config();

churchtoolsClient.setCookieJar(axiosCookieJarSupport.wrapper, new tough.CookieJar());
churchtoolsClient.setBaseUrl(process.env.BASE_URL);

activateLogging();

const user = {
    username: process.env.USER,
    password: process.env.PASSWORD
}

async function login(client, user) {
    let result = await client.post('/login', user)
    if (result.status === 'success') {
        console.log('Login successful!');
        return true;
    } else {
        console.log('Login failed! Exiting...');
        process.exit(1);
    }
}

login(churchtoolsClient, user)

churchtoolsClient.get('/events').then(events => {
    console.log('Events: ', events);

    const formattedEvents = formatEvents(events);
});


function formatEvents(events) {
    let formattedEvents = {};

    for(let i = 0; i < events.length; i++) {
        if (!events[i].note.includes('streaming: ja')) continue;

        if (!formattedEvents[events[i].guid]) {
            formattedEvents[events[i].guid] = {
                date: new Date(events[i].startDate).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
                name: events[i].name,
                startTime: new Date(events[i].startDate).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            }
        };
    };
    return formattedEvents;
}
