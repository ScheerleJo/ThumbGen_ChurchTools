require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const { parseArgs } = require('util');
const ct = require('./churchtools');
const sync = require('./sync');
const text = require('./text');

const HELP = `Verwendung: node index.js [Optionen]

  --watch           Dauerhaft laufen und ChurchTools regelmäßig prüfen
  --interval <min>  Prüfintervall im Watch-Modus (Standard: WATCH_INTERVAL_MINUTES oder 15)
  --days <n>        Events von heute bis in n Tagen (Standard: 7)
  --event <id>      Nur dieses Event (ID aus ChurchTools)
  --dry-run         Nur anzeigen, was passieren würde, nichts schreiben
  --force           Auch Events mit nicht abgeschlossener Agenda / ohne Thema rendern
  --rebuild         Alle Thumbnails neu erzeugen, auch wenn sich nichts geändert hat
  --demo            Ohne ChurchTools Beispiel-Thumbnails rendern
  --verbose         HTTP-Logging des ChurchTools-Clients
  --help            Diese Hilfe`;

function timestamp() {
    return new Date().toLocaleString('de-DE', { timeZone: process.env.TIMEZONE || 'Europe/Berlin' });
}

async function runDemo() {
    const base = {
        isoDate: '2026-05-14', date: '14.05.2026', startTime: '09:45', eventName: 'Gottesdienst',
        sermonSubject: 'Der letzte Wille von Jesus: Einheit', preacher: 'Max Mustermann',
        scripture: 'Johannes 17,20-26', scriptureLink: text.bibleserverLink('Johannes 17,20-26'),
    };
    for (const info of [base, { ...base, eventName: 'Familiengottesdienst', sermonSubject: 'Gemeinsam unterwegs' }]) {
        const output = sync.buildOutput(info);
        await sync.writeOutput(info, output);
        console.log(`-> ${output.image} | ${output.title}`);
    }
}

async function runCycle(args, log) {
    await ct.login({
        loginToken: process.env.CT_LOGIN_TOKEN,
        username: process.env.CT_USERNAME,
        password: process.env.CT_PASSWORD,
    });
    const stats = await sync.syncOnce({
        days: Number(args.days),
        eventId: args.event,
        dryRun: args['dry-run'],
        force: args.force,
        rebuild: args.rebuild,
        sermonItemTitle: process.env.SERMON_ITEM_TITLE,
        log,
    });
    log(`Fertig: ${stats.created} neu, ${stats.updated} aktualisiert, ${stats.removed} entfernt, `
        + `${stats.unchanged} unverändert, ${stats.skipped} übersprungen, ${stats.failed} Fehler.`);
    return stats;
}

async function watch(args) {
    const minutes = Number(args.interval || process.env.WATCH_INTERVAL_MINUTES || 15);
    if (!(minutes > 0)) throw new Error('Ungültiges Intervall: ' + args.interval);
    const log = msg => console.log(`[${timestamp()}] ${msg}`);
    log(`Watch-Modus: prüfe alle ${minutes} Minuten (Strg+C zum Beenden).`);

    let timer = null;
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        clearTimeout(timer);
        log('Beendet.');
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    let rebuild = args.rebuild; // --rebuild nur beim ersten Durchlauf
    const tick = async () => {
        try {
            await runCycle({ ...args, rebuild }, log);
        } catch (err) {
            // z. B. Netzwerk weg oder Login abgelaufen – beim nächsten Durchlauf erneut versuchen
            log(`Fehler beim Abgleich: ${err.message}`);
        }
        rebuild = false;
        if (!stopping) timer = setTimeout(tick, minutes * 60 * 1000);
    };
    await tick();
}

async function main() {
    const { values: args } = parseArgs({
        options: {
            watch: { type: 'boolean', default: false },
            interval: { type: 'string' },
            days: { type: 'string', default: '7' },
            event: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            force: { type: 'boolean', default: false },
            rebuild: { type: 'boolean', default: false },
            demo: { type: 'boolean', default: false },
            verbose: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });
    if (args.help) return console.log(HELP);
    if (args.demo) return runDemo();

    ct.init({ baseUrl: process.env.CT_BASE_URL, verbose: args.verbose });
    if (args.watch) return watch(args);

    const stats = await runCycle(args, console.log);
    if (stats.failed) process.exitCode = 1;
}

main().catch(err => {
    console.error('Fehler:', err.message);
    process.exit(1);
});
