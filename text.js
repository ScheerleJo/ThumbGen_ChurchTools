// Auslesen der Infos aus ChurchTools-Events und -Agenden

function stripHtml(text) {
    return (text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

/** Liest "Schlüssel: Wert" aus einem mehrzeiligen Text, unabhängig von Reihenfolge und Groß-/Kleinschreibung. */
function readField(text, key) {
    const match = stripHtml(text).match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im'));
    return match ? match[1] : null;
}

function isStreamed(event) {
    return /streaming\s*:\s*ja\b/i.test(stripHtml(event.note));
}

function selectEvent(eventName) {
    const name = (eventName || '').toLowerCase();
    if (name.includes('familien')) return 'Familiengottesdienst';
    if (name.includes('jugend')) return 'Jugendgottesdienst';
    return 'Gottesdienst';
}

function findSermonItem(agenda, sermonItemTitle = 'Predigt') {
    const items = agenda?.items || [];
    const needle = sermonItemTitle.toLowerCase();
    return items.find(item => (item.title || '').toLowerCase().includes(needle))
        // Fallback: irgendein Eintrag, dessen Notiz ein Thema enthält
        || items.find(item => readField(item.note, 'Thema'));
}

function getResponsiblePerson(agendaItem) {
    const responsible = agendaItem?.responsible;
    if (!responsible) return null;
    const accepted = (responsible.persons || []).filter(p => p.accepted && p.person);
    if (accepted.length) return accepted.map(p => p.person.title).join(', ');
    // Freitext (ohne [Dienst]-Platzhalter) direkt übernehmen
    const text = (responsible.text || '').trim();
    if (text && !text.includes('[')) return text;
    return null;
}

/** Thema und Predigttext aus dem Predigt-Eintrag der Agenda, Fallback: Event-Notiz. */
function getSermonInfo(agendaItem, event) {
    return {
        subject: readField(agendaItem?.note, 'Thema') || readField(event?.note, 'Thema'),
        scripture: readField(agendaItem?.note, 'Predigttext') || readField(event?.note, 'Predigttext'),
    };
}

function bibleserverLink(scripture) {
    if (!scripture) return '';
    return 'https://www.bibleserver.com/LUT/' + encodeURIComponent(scripture.replace(/\s+/g, ''));
}

module.exports = { isStreamed, selectEvent, findSermonItem, getResponsiblePerson, getSermonInfo, bibleserverLink, readField };
