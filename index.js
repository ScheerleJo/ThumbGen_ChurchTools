const { churchtoolsClient, activateLogging } = require('@churchtools/churchtools-client');
const axiosCookieJarSupport = require('axios-cookiejar-support');
const tough = require('tough-cookie');
require('dotenv').config();
const canvas = require('./canvas');

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
    // let fromDate = new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0];
    // let toDate = new Date(new Date().setDate(new Date().getDate() + 7)).toISOString().split('T')[0]; 
    const events = await churchtoolsClient.get(`/events`);
    // console.log('Events:', events);
    return await formatEvents(events);
}

async function getEventAgenda(eventId) {
    const agenda = await churchtoolsClient.get(`/events/${eventId}/agenda`);
    console.log('Agenda:', agenda);
    return agenda;
}

function getResponsiblePerson(agendaItem) {
    if(!agendaItem.responsible.text.includes('[')) return agendaItem.text;
    if(agendaItem.responsible.personns[0].accepted) return agendaItem.responsible.persons[0].person.title
    throw Error("No user or not accepted user in service: " + agendaItem.responsible.persons[0].service)
}

function getSermonInfo(agendaItem) {
    if(agendaItem.note) {
        let infos = agendaItem.note.split('\n');
        infos[0] = infos[0].replace('Predigttext:', '').trim()
        infos[1] = infos[1].replace('Thema:', '').trim()
        return infos;
    }
}


async function formatEvents(events) {
    let formattedEvents = [];
    for(let i = 0; i < events.length; i++) {
        if (!events[i].note.includes('streaming: ja')) {
            console.log("No Livestream. Skipping event:", events[i].name);
            continue;
        } 

        formattedEvents.push({
            date: new Date(events[i].startDate).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
            eventName: selectEvent(events[i].name),
            sermonSubject: '',
            startTime: new Date(events[i].startDate).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            preacher: '',
            scripture: '',
            scriptureLink: '',
            specialties: []
        })
    }
    return formattedEvents;
}

function selectEvent(eventName) {
    if (eventName.includes("Familien")) return 'Familiengottesdienst';
    else if (eventName.includes("Jugend")) return 'Jugendgottesdienst';
    else return 'Gottesdienst';
}

const user = {
    username: process.env.USER,
    password: process.env.PASSWORD
}

login(churchtoolsClient, user)

getEvents().then(events => {
    const eventList = events;
    console.log("Events:", eventList);
    canvas.create({
        date: eventList[0].date,
        event: eventList[0].eventName,
        subject: eventList[0].sermonSubject
    })
});
// getEventAgenda(191);