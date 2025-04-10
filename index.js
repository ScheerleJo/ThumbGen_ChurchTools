const { churchtoolsClient, activateLogging } = require('@churchtools/churchtools-client');
const axiosCookieJarSupport = require('axios-cookiejar-support');
const tough = require('tough-cookie');
require('dotenv').config();
const canvas = require('./canvas');

canvas.create({
    date: '13.04.2025', 
    event: 'Familiengottesdienst',
    subject: 'Hier steht das Thema\nder Predigt!'
});

churchtoolsClient.setCookieJar(axiosCookieJarSupport.wrapper, new tough.CookieJar());
churchtoolsClient.setBaseUrl(process.env.BASE_URL);

activateLogging();

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

async function getEvents() {
    return formatEvents(await churchtoolsClient.get('/events'));
}

async function getEventAgenda(eventId) {
    const agenda = await churchtoolsClient.get(`/events/${eventId}/agenda`);
    console.log('Agenda:', agenda);
    return agenda;
}

async function getResponsiblePerson(agendaEntry) {
    if(!agendaEntry.responsible.text.includes('[')) return agendaEntry.text;
    let responsible = agendaEntry.responsible.persons[0].person.title
    if(responsible) return responsible;

}

async function formatEvents(events) {
    let formattedEvents = {};
    for(let i = 0; i < events.length; i++) {
        if (!events[i].note.includes('streaming: ja')) continue;

        if (!formattedEvents[events[i].guid]) {
            formattedEvents[events[i].guid] = {
                date: new Date(events[i].startDate).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
                eventName: events[i].name,
                sermonSubject: '',
                startTime: new Date(events[i].startDate).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                preacher: '',
                scripture: '',
                scriptureLink: '',
                specialties: []
            }
        };
    };
    return formattedEvents;
}

const user = {
    username: process.env.USER,
    password: process.env.PASSWORD
}

login(churchtoolsClient, user)
getEvents()
getEventAgenda(38);