'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const FIELDS = [
    ['sermonSubject', 'Thema'],
    ['eventName', 'Art'],
    ['preacher', 'Prediger'],
    ['scripture', 'Predigttext'],
];
const STATUS = {
    'neu': ['Thumbnail erstellt', 'ok'],
    'aktualisiert': ['Thumbnail aktualisiert', 'ok'],
    'unverändert': ['Thumbnail aktuell', 'ok'],
    'übersprungen': ['Kein Thumbnail', 'warn'],
    'fehler': ['Fehler', 'err'],
};
const PRIVACY = {
    public: ['Öffentlich', 'ok'],
    unlisted: ['Nicht gelistet', 'warn'],
    private: ['Privat', 'err'],
};
const LIFECYCLE = {
    created: 'geplant', ready: 'geplant', testing: 'Test läuft', testStarting: 'Test startet',
    liveStarting: 'startet', live: 'LIVE', complete: 'beendet', revoked: 'gesperrt',
};

let state = { status: null, events: [], openEditor: null, newOpen: false, bgKey: '', bgVersion: 0 };

// ---------- API ----------
async function parseResponse(res) {
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.headers.get('content-type')?.includes('json') ? res.json() : res.blob();
}

async function api(method, url, body) {
    return parseResponse(await fetch(url, {
        method,
        headers: { 'X-ThumbGen': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    }));
}

// ---------- Hilfsfunktionen ----------
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'checked') node.checked = Boolean(value);
        else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
}

const pill = (label, kind = '') => el('span', { class: `pill ${kind}` }, label);

function formatWhen(iso) {
    const d = new Date(iso);
    const day = d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    return `${day}, ${time} Uhr`;
}

function formatAgo(iso) {
    if (!iso) return 'noch nie';
    const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return `vor ${minutes} Min.`;
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function showAlert(message, kind = '') {
    const box = el('div', { class: `alert ${kind}`, role: 'alert' }, message);
    $('#alerts').append(box);
    setTimeout(() => box.remove(), 8000);
}

async function withBusy(buttons, fn) {
    buttons.forEach(b => { b.disabled = true; });
    try {
        return await fn();
    } catch (err) {
        showAlert(err.message);
        return null;
    } finally {
        buttons.forEach(b => { b.disabled = false; });
    }
}

function openLightbox(src) {
    const dialog = el('dialog', { class: 'lightbox', onclick: () => dialog.close(), onclose: () => dialog.remove() },
        el('img', { src, alt: 'Bild in voller Größe' }));
    document.body.append(dialog);
    dialog.showModal();
}

/** Nächster Sonntag als YYYY-MM-DD (Vorschlag für neue Streams). */
function nextSunday() {
    const d = new Date();
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
    return d.toLocaleDateString('en-CA');
}

// ---------- Hintergründe ----------
const backgroundList = () => state.status?.backgrounds || [];
const bgLabel = name => (name === 'default' ? 'Standard' : name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, ' '));
const bgImage = name => `/api/backgrounds/${encodeURIComponent(name)}/image?v=${state.bgVersion}`;
const normalizeBgName = name => name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9äöüß_-]/g, '').slice(0, 40);

/** Fragt nach einem Namen und lädt das Bild hoch. Gibt den gespeicherten Namen zurück (oder null). */
async function uploadBackground(file) {
    if (!file) return null;
    if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Bitte ein PNG- oder JPEG-Bild auswählen');
    const input = prompt('Name für den Hintergrund:\n\nHeißt er wie eine Gottesdienst-Art (z. B. „jugendgottesdienst“), '
        + 'wird er dafür automatisch verwendet.', normalizeBgName(file.name.replace(/\.[^.]+$/, '')));
    if (input === null) return null;
    const name = normalizeBgName(input);
    if (!name) throw new Error('Bitte einen Namen aus Buchstaben, Ziffern, - oder _ angeben');
    const existing = backgroundList().find(b => b.name === name);
    if (existing?.builtin) throw new Error(`„${name}“ ist ein mitgelieferter Hintergrund – bitte einen anderen Namen wählen`);
    if (existing && !confirm(`Den Hintergrund „${name}“ ersetzen? Thumbnails, die ihn verwenden, werden beim nächsten Abgleich neu erstellt.`)) {
        return null;
    }
    const { background } = await parseResponse(await fetch(`/api/backgrounds?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'X-ThumbGen': '1', 'Content-Type': file.type },
        body: file,
    }));
    state.bgVersion++;
    await loadStatus();
    showAlert(`Hintergrund „${bgLabel(background.name)}“ gespeichert.`, 'ok');
    return background.name;
}

const uploadTile = (label, onFile) => el('label', { class: 'bg-option bg-upload' },
    el('input', {
        type: 'file', accept: 'image/png,image/jpeg',
        onchange: e => {
            e.stopPropagation();
            const file = e.target.files[0];
            e.target.value = '';
            onFile(file);
        },
    }),
    el('span', { class: 'bg-placeholder' }, '+ Hochladen'),
    el('span', { class: 'bg-name muted' }, label));

function renderBackgroundPanel() {
    const list = backgroundList();
    $('#bg-count').textContent = `(${list.length})`;
    $('#bg-grid').replaceChildren(...list.map(bg => el('div', { class: 'bg-tile' },
        el('img', { src: bgImage(bg.name), alt: '', loading: 'lazy', onclick: () => openLightbox(bgImage(bg.name)) }),
        el('div', { class: 'bg-meta' },
            el('span', { class: 'bg-name', title: bg.name }, bgLabel(bg.name)),
            bg.builtin
                ? el('span', { class: 'muted' }, 'mitgeliefert')
                : el('button', {
                    class: 'btn small danger', type: 'button', title: 'Hintergrund löschen',
                    onclick: async e => {
                        if (!confirm(`Hintergrund „${bgLabel(bg.name)}“ löschen?`)) return;
                        await withBusy([e.currentTarget], async () => {
                            await api('DELETE', `/api/backgrounds/${encodeURIComponent(bg.name)}`);
                            await loadStatus();
                        });
                    },
                }, 'Löschen')))),
    uploadTile('PNG oder JPEG', file => withBusy([], () => uploadBackground(file))));
}

/** Auswahl im Editor: "Automatisch" + alle Hintergründe + Hochladen. */
function renderPicker(picker, selected, onChange) {
    const option = (value, visual, label, title) => el('label', { class: 'bg-option', title },
        el('input', { type: 'radio', name: 'background', value, checked: value === selected }),
        visual, el('span', { class: 'bg-name' }, label));
    picker.replaceChildren(
        option('', el('span', { class: 'bg-placeholder' }, 'Auto'), 'Automatisch', 'Passend zur Art des Gottesdienstes'),
        ...backgroundList().map(bg => option(bg.name, el('img', { src: bgImage(bg.name), alt: '', loading: 'lazy' }), bgLabel(bg.name), bg.name)),
        uploadTile('Eigener', async file => {
            const current = picker.querySelector('input[name=background]:checked')?.value || '';
            const name = await withBusy([], () => uploadBackground(file));
            renderPicker(picker, name || current, onChange);
            if (name) onChange();
        }),
    );
}

// ---------- Rendering ----------
function renderStatus() {
    const s = state.status;
    if (!s) return;
    const pillEl = $('#status-pill');
    if (s.running) {
        pillEl.className = 'pill info running';
        pillEl.textContent = 'Abgleich läuft';
    } else if (s.lastError) {
        pillEl.className = 'pill err';
        pillEl.textContent = 'Fehler';
        pillEl.title = s.lastError;
    } else {
        pillEl.className = 'pill ok';
        pillEl.textContent = 'Bereit';
        pillEl.title = '';
    }
    $('#sync-btn').disabled = s.running;
    const range = s.range ? ` · Zeitraum ${s.range.from} bis ${s.range.to}` : '';
    const yt = s.youtube.enabled ? `YouTube aktiv (neue Livestreams: ${PRIVACY[s.youtube.privacyDefault]?.[0] || s.youtube.privacyDefault})` : 'YouTube aus';
    $('#sync-info').textContent = `Letzter Abgleich ${formatAgo(s.lastSync)}${range} · ${yt}`;
    $('#log').textContent = s.log.join('\n') || 'Noch keine Einträge.';

    // Hintergründe nur neu zeichnen, wenn sich etwas geändert hat (sonst laden die Bilder bei jedem Poll neu)
    const bgKey = JSON.stringify(s.backgrounds) + state.bgVersion;
    if (bgKey !== state.bgKey) {
        state.bgKey = bgKey;
        const types = new Set(['Gottesdienst', 'Familiengottesdienst', 'Jugendgottesdienst',
            ...s.backgrounds.filter(b => b.name !== 'default').map(b => bgLabel(b.name))]);
        $('#event-types').replaceChildren(...[...types].map(t => el('option', { value: t })));
        renderBackgroundPanel();
    }
}

function renderEvents() {
    const container = $('#events');
    const streamed = state.events.filter(e => e.streamed && !e.canceled);
    const others = state.events.filter(e => !e.streamed || e.canceled);

    if (!state.events.length) {
        container.replaceChildren(el('div', { class: 'empty' },
            'Noch keine Daten. Klicke auf „ChurchTools abfragen“, um die Events zu laden.'));
    } else if (!streamed.length) {
        container.replaceChildren(el('div', { class: 'empty' }, 'Im Zeitraum ist kein Event mit Livestream geplant.'));
    } else {
        container.replaceChildren(...streamed.map(renderEvent));
    }

    $('#other-events').hidden = !others.length;
    $('#other-count').textContent = `(${others.length})`;
    $('#other-list').replaceChildren(...others.map(e => el('li', {},
        el('strong', {}, formatWhen(e.startDate)), ' – ', e.name, ' ', pill(e.canceled ? 'abgesagt' : 'kein Livestream'))));
}

function renderEvent(event) {
    const node = $('#event-template').content.firstElementChild.cloneNode(true);
    node.dataset.id = event.id;
    const info = event.info || {};
    const ct = event.ctInfo || {};
    const override = event.override || {};

    // Thumbnail
    const img = $('.thumb', node);
    if (event.thumbnail) {
        img.src = `/api/thumbnail/${encodeURIComponent(event.thumbnail)}?v=${event.fingerprint || ''}`;
        img.alt = `Thumbnail ${event.name}`;
        img.addEventListener('click', () => openLightbox(img.src));
        $('.thumb-empty', node).hidden = true;
    } else {
        img.hidden = true;
    }

    // Kopf
    $('.event-when', node).textContent = formatWhen(event.startDate);
    $('.event-name', node).textContent = event.name;
    const [statusLabel, statusKind] = STATUS[event.status] || [event.status || '–', ''];
    $('.badges', node).append(...[
        pill(statusLabel, statusKind),
        event.manual
            ? pill('Im Dashboard angelegt', 'info')
            : pill(`Agenda ${event.agenda || '–'}`, event.agenda === 'abgeschlossen' ? '' : 'warn'),
        Object.keys(override).length ? pill('angepasst', 'info') : null,
    ].filter(Boolean));

    // Probleme
    const problems = [...event.problems];
    if (event.status === 'fehler' && event.message) problems.push(event.message);
    if (problems.length) {
        let hint = '';
        if (event.manual) {
            hint = ' – über „Bearbeiten“ kannst du es ergänzen.';
        } else if (event.status === 'übersprungen') {
            hint = ' – über „Anpassen“ kannst du die Werte selbst eintragen und das Thumbnail trotzdem erzeugen.';
        } else if (event.status !== 'fehler' && event.thumbnail && !event.override?.force) {
            hint = ' – das bestehende Thumbnail bleibt unverändert, bis die Agenda abgeschlossen ist (oder du es über „Anpassen“ erzwingst).';
        }
        $('.problems', node).append(el('div', { class: `alert ${event.status === 'fehler' ? '' : 'warn'}` },
            problems.join(', ') + (event.status === 'fehler' ? '' : hint)));
    }

    // Felder
    const dl = $('.fields', node);
    for (const [key, label] of FIELDS) {
        const value = info[key] || '';
        const changed = override[key] !== undefined;
        const dd = el('dd', {}, value || el('span', { class: 'muted' }, '—'));
        if (key === 'scripture' && value && info.scriptureLink) {
            dd.replaceChildren(el('a', { href: info.scriptureLink, target: '_blank', rel: 'noopener' }, value));
        }
        if (changed) {
            dd.append(el('span', { class: 'changed' }, 'angepasst'),
                el('span', { class: 'ct-was' }, `ChurchTools: ${ct[key] || '—'}`));
        }
        dl.append(el('dt', {}, label), dd);
    }
    if (event.background) {
        dl.append(el('dt', {}, 'Hintergrund'), el('dd', {},
            bgLabel(event.background.name),
            event.background.auto ? el('span', { class: 'muted' }, ' (automatisch)') : null,
            override.background ? el('span', { class: 'changed' }, 'angepasst') : null));
    }

    renderYoutube($('.youtube', node), event);

    // Details
    const details = $('.details-body', node);
    const block = (title, content) => el('div', {}, el('h3', {}, title), el('pre', {}, content || '—'));
    if (event.manual) {
        $('.details summary', node).textContent = 'Notiz & YouTube-Texte';
        details.append(block('Notiz', event.note));
    } else {
        details.append(
            block('Event-Notiz', event.note),
            block(`Agenda-Eintrag${event.sermonItem?.title ? ` „${event.sermonItem.title}“` : ''}`,
                event.sermonItem ? [event.sermonItem.note, event.sermonItem.responsible && `Verantwortlich: ${event.sermonItem.responsible}`].filter(Boolean).join('\n\n') : 'Kein Predigt-Eintrag gefunden'),
        );
    }
    details.append(block('YouTube-Titel', event.title), block('YouTube-Beschreibung', event.description));

    // Editor
    const editor = $('.editor', node);
    const editBtn = $('.edit-btn', node);
    const closedLabel = event.manual ? 'Bearbeiten' : 'Anpassen';
    editBtn.textContent = closedLabel;
    if (!event.ctInfo) editBtn.hidden = true;
    const toggle = open => {
        editor.hidden = !open;
        editBtn.textContent = open ? `${closedLabel} schließen` : closedLabel;
        state.openEditor = open ? event.id : (state.openEditor === event.id ? null : state.openEditor);
        if (open && !editor.dataset.ready) {
            editor.dataset.ready = '1';
            setupEditor(editor, { event, onDone: () => { state.openEditor = null; } });
        }
    };
    editBtn.addEventListener('click', () => toggle(editor.hidden));
    if (event.manual) {
        const deleteBtn = el('button', { class: 'btn danger', type: 'button' }, 'Löschen');
        deleteBtn.addEventListener('click', () => deleteManualStream(event, [deleteBtn, editBtn]));
        editBtn.after(deleteBtn);
    }
    $('.cancel-btn', editor).addEventListener('click', () => {
        state.openEditor = null;
        renderEvents();
    });
    if (state.openEditor === event.id) toggle(true);
    return node;
}

function renderYoutube(box, event) {
    if (!state.status?.youtube.enabled) return;
    if (!event.youtubeId) {
        box.append(el('span', { class: 'label' }, 'YouTube'), el('span', { class: 'muted' },
            event.thumbnail ? 'Livestream wird beim nächsten Abgleich angelegt' : 'Noch kein Livestream'));
        return;
    }
    const yt = event.youtube || {};
    if (yt.missing) {
        box.append(el('span', { class: 'label' }, 'YouTube'),
            pill('auf YouTube gelöscht', 'err'),
            el('span', { class: 'muted' }, 'wird beim nächsten geänderten Abgleich neu angelegt'));
        return;
    }
    const [privacyLabel, privacyKind] = PRIVACY[yt.privacy] || [yt.privacy || '?', ''];
    const lifecycle = LIFECYCLE[yt.lifeCycle] || yt.lifeCycle;
    box.append(...[
        el('span', { class: 'label' }, 'YouTube'),
        pill(privacyLabel, privacyKind),
        lifecycle ? pill(lifecycle, yt.lifeCycle === 'live' ? 'err' : '') : null,
        el('a', { href: yt.watchUrl, target: '_blank', rel: 'noopener' }, 'Ansehen'),
        el('a', { href: yt.studioUrl, target: '_blank', rel: 'noopener' }, 'YouTube Studio'),
        el('span', { class: 'spacer' }),
    ].filter(Boolean));
    if (yt.lifeCycle === 'complete' || yt.lifeCycle === 'revoked') return;

    const setPrivacy = (privacy, confirmText) => async e => {
        if (confirmText && !confirm(confirmText)) return;
        await withBusy([e.currentTarget], async () => {
            await api('POST', `/api/events/${event.id}/privacy`, { privacy });
            await loadEvents();
        });
    };
    if (yt.privacy !== 'public') {
        box.append(el('button', {
            class: 'btn small publish', type: 'button',
            onclick: setPrivacy('public', `„${yt.title}“ jetzt öffentlich schalten?\n\nDer Livestream erscheint dann auf dem Kanal und in der Suche.`),
        }, 'Öffentlich schalten'));
    } else {
        box.append(el('button', { class: 'btn small', type: 'button', onclick: setPrivacy('unlisted') }, 'Auf nicht gelistet'));
    }
}

// ---------- Editor (ChurchTools-Anpassung, manueller Stream, neuer Stream) ----------

/**
 * @param {HTMLFormElement} form
 * @param {{event?: object, onDone: () => void}} options  ohne event = neuer Stream
 */
function setupEditor(form, { event, onDone }) {
    const isNew = !event;
    const manual = isNew || Boolean(event.manual);
    const override = (!isNew && event.override) || {};
    const info = event?.info || {};

    form.querySelectorAll('.manual-only').forEach(n => { n.hidden = !manual; });
    $('.reset-btn', form).hidden = manual || !Object.keys(override).length;
    $('.delete-btn', form).hidden = !manual || isNew;
    $('button[type=submit]', form).textContent = isNew ? (state.status?.youtube.enabled ? 'Anlegen (nicht gelistet)' : 'Anlegen') : 'Speichern & anwenden';
    if (manual) $('textarea[name=sermonSubject] + small', form).textContent = 'Enter = eigener Zeilenumbruch im Thumbnail.';

    if (manual) {
        form.elements.date.value = info.isoDate || nextSunday();
        form.elements.time.value = info.startTime || '10:00';
        form.elements.date.required = true;
        form.elements.time.required = true;
        for (const [key] of FIELDS) form.elements[key].value = info[key] || '';
        if (isNew) form.elements.eventName.value = 'Gottesdienst';
        form.elements.note.value = event?.note || '';
    } else {
        const ct = event.ctInfo;
        for (const [key] of FIELDS) {
            const input = form.elements[key];
            input.value = override[key] || '';
            input.placeholder = ct[key] || '';
        }
        const needsForce = event.problems.some(p => p.includes('Agenda')) || override.force;
        $('.force-row', form).hidden = !needsForce;
        form.elements.force.checked = Boolean(override.force);
    }

    const values = () => {
        const result = {};
        for (const [key] of FIELDS) result[key] = form.elements[key].value;
        result.background = form.querySelector('input[name=background]:checked')?.value || '';
        if (manual) {
            result.date = form.elements.date.value;
            result.time = form.elements.time.value;
            result.note = form.elements.note.value;
        } else {
            result.force = form.elements.force.checked;
        }
        return result;
    };

    // Live-Vorschau
    const previewImg = $('.preview', form);
    const previewState = $('.preview-state', form);
    const previewUrl = manual ? '/api/preview' : `/api/events/${event.id}/preview`;
    let timer = null;
    let counter = 0;
    const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const current = ++counter;
            previewState.textContent = 'Vorschau wird erstellt …';
            try {
                const blob = await api('POST', previewUrl, values());
                if (current !== counter) return;
                if (previewImg.src) URL.revokeObjectURL(previewImg.src);
                previewImg.src = URL.createObjectURL(blob);
                previewState.textContent = isNew ? 'Vorschau – noch nicht angelegt' : 'Vorschau – noch nicht gespeichert';
            } catch (err) {
                previewState.textContent = 'Vorschau fehlgeschlagen: ' + err.message;
            }
        }, 350);
    };
    renderPicker($('.bg-picker', form), (manual ? info.background : override.background) || '', refresh);
    form.addEventListener('input', e => { if (e.target.type !== 'file') refresh(); });
    refresh();

    const buttons = [...form.querySelectorAll('button')];
    const finish = async () => {
        onDone();
        await Promise.all([loadEvents(), loadStatus()]);
    };
    form.addEventListener('submit', async e => {
        e.preventDefault();
        await withBusy(buttons, async () => {
            let result;
            if (isNew) result = await api('POST', '/api/manual', values());
            else if (manual) result = await api('PUT', `/api/manual/${event.id}`, values());
            else result = await api('PUT', `/api/events/${event.id}/override`, values());
            if (result.stats?.failed) showAlert('Gespeichert, aber beim Abgleich gab es einen Fehler – siehe Protokoll.', 'warn');
            else if (isNew) showAlert(state.status?.youtube.enabled ? 'Gottesdienst angelegt – der Livestream ist nicht gelistet, bis du ihn öffentlich schaltest.' : 'Gottesdienst angelegt.', 'ok');
            await finish();
            if (isNew) document.querySelector(`.event[data-id="${CSS.escape(result.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    });
    $('.reset-btn', form).addEventListener('click', async () => {
        if (!confirm('Alle Anpassungen für dieses Event verwerfen und wieder die Werte aus ChurchTools verwenden?')) return;
        await withBusy(buttons, async () => {
            await api('DELETE', `/api/events/${event.id}/override`);
            await finish();
        });
    });
    $('.delete-btn', form).addEventListener('click', () => deleteManualStream(event, buttons, onDone));
}

/** Löscht einen im Dashboard angelegten Gottesdienst (Thumbnail + YouTube-Livestream, falls noch nicht live). */
async function deleteManualStream(event, buttons, onDone = () => {}) {
    const ytNote = event.youtubeId ? '\n\nDer YouTube-Livestream wird ebenfalls gelöscht (sofern er noch nicht live war).' : '';
    if (!confirm(`Den Gottesdienst „${event.name}“ am ${formatWhen(event.startDate)} löschen?${ytNote}`)) return;
    await withBusy(buttons, async () => {
        await api('DELETE', `/api/manual/${event.id}`);
        if (state.openEditor === event.id) state.openEditor = null;
        onDone();
        showAlert(`„${event.name}“ wurde gelöscht.`, 'ok');
        await Promise.all([loadEvents(), loadStatus()]);
    });
}

function openNewStream() {
    if (state.newOpen) {
        $('#new-stream .event')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    state.newOpen = true;
    const template = $('#event-template').content.firstElementChild.cloneNode(true);
    const form = $('.editor', template);
    form.hidden = false;
    const close = () => {
        state.newOpen = false;
        $('#new-stream').replaceChildren();
    };
    const card = el('article', { class: 'event new-stream' },
        el('h2', {}, 'Neuer Gottesdienst'),
        el('p', { class: 'muted' }, 'Für Gottesdienste, die nicht in ChurchTools stehen. Das Thumbnail wird sofort erstellt.'),
        state.status?.youtube.enabled
            ? el('div', { class: 'alert warn' },
                'Der Livestream wird auf YouTube erst einmal als „nicht gelistet“ angelegt. '
                + 'Prüfe ihn hier und in YouTube Studio und schalte ihn dann mit „Öffentlich schalten“ frei.')
            : null,
        form);
    $('#new-stream').replaceChildren(card);
    setupEditor(form, { onDone: close });
    $('.cancel-btn', form).addEventListener('click', close);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.sermonSubject.focus({ preventScroll: true });
}

// ---------- Laden ----------
async function loadStatus() {
    const wasRunning = state.status?.running;
    state.status = await api('GET', '/api/status');
    renderStatus();
    if (wasRunning && !state.status.running && !state.openEditor) await loadEvents();
}

async function loadEvents() {
    const data = await api('GET', '/api/events');
    state.events = data.events;
    if (data.youtubeError) showAlert('YouTube-Status konnte nicht geladen werden: ' + data.youtubeError, 'warn');
    renderEvents();
}

$('#sync-btn').addEventListener('click', async e => {
    await withBusy([e.currentTarget], async () => {
        const promise = api('POST', '/api/sync');
        setTimeout(loadStatus, 300); // "läuft" sofort anzeigen
        await promise;
        await Promise.all([loadStatus(), loadEvents()]);
    });
});
$('#new-btn').addEventListener('click', openNewStream);

async function poll() {
    try {
        await loadStatus();
    } catch {
        $('#status-pill').className = 'pill err';
        $('#status-pill').textContent = 'Keine Verbindung';
    }
    setTimeout(poll, state.status?.running ? 2000 : 10000);
}

(async () => {
    try {
        await loadStatus();
        await loadEvents();
    } catch (err) {
        showAlert('Dashboard konnte nicht geladen werden: ' + err.message);
    }
    setTimeout(poll, 10000);
})();
