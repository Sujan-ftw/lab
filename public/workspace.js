'use strict';
const isAdmin = document.body.dataset.role === 'admin';
const userName = document.body.dataset.name;
const dept = document.body.dataset.dept;

let data = {}, page = 'Overview', ops = {}, zone = 'Asia/Kolkata', timer;

const nav = isAdmin ? [
    ['Overview', 'grid'],
    ['Examinations', 'layers'],
    ['Attendance Sheets', 'file'],
    ['Staff Management', 'person'],
    ['Staff Directory', 'book'],
    ['Calendar', 'calendar'],
    ['Analytics', 'chart'],
    ['Activity Timeline', 'activity'],
    ['Audit Logs', 'shield'],
    ['Export History', 'download'],
    ['Settings', 'settings']
] : [
    ['Examinations', 'layers'],
    ['New Examination', 'plus'],
    ['Attendance Sheets', 'file'],
    ['Profile', 'person']
];

const historyPage = isAdmin ? 'Examinations' : 'Examinations';

function act(name, fn) { ops[name] = fn; }
function btn(label, key, cls = '', icon = '') {
    return '<button type="button" class="' + cls + '" data-action="' + E(key) + '">' + (icon ? ico(icon) : '') + E(label) + '</button>';
}
function title(name, desc = '', action = '') {
    return '<div class="page-title"><div><div class="eyebrow">' + (isAdmin ? 'ADMINISTRATOR WORKSPACE' : 'FACULTY WORKSPACE') + '</div><h1>' + E(name) + '</h1>' + (desc ? '<p>' + E(desc) + '</p>' : '') + '</div>' + action + '</div>';
}
function card(label, body, action = '') {
    return '<section class="card"><div class="card-head"><h2>' + E(label) + '</h2>' + action + '</div>' + body + '</section>';
}
function table(cols, lines, msg = 'No records yet.') {
    return lines.length ? '<div class="tablewrap"><table><thead><tr>' + cols.map(c => '<th>' + E(c) + '</th>').join('') + '</tr></thead><tbody>' + lines.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<div class="empty">' + ico('layers') + E(msg) + '</div>';
}
function statList(list) {
    return '<div class="stats">' + list.map(([name, val, icon]) => '<div class="stat">' + ico(icon || 'layers') + '<small>' + E(name) + '</small><b>' + E(val) + '</b></div>').join('') + '</div>';
}
function badge(s) { return '<span class="badge ' + E(s) + '">' + E(s) + '</span>'; }
function time(s, only = false) {
    if (!s) return '—';
    const str = String(s), d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
    return isNaN(d) ? '—' : new Intl.DateTimeFormat('en-IN', { timeZone: zone, dateStyle: 'medium', ...(only ? {} : { timeStyle: 'short' }) }).format(d);
}
function localDay(s) {
    const str = String(s || '');
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(s ? new Date(/[zZ]$/.test(str) ? str : str.replace(' ', 'T') + 'Z') : new Date());
}
function notice(s) {
    $('#toast').textContent = s;
    clearTimeout(timer);
    timer = setTimeout(() => $('#toast').textContent = '', 5000);
}
function modal(name, body) {
    $('#modal').innerHTML = '<div class="card-head"><h2>' + E(name) + '</h2>' + btn('Close', 'close') + '</div>' + body;
    if (!$('#dialog').open) $('#dialog').showModal();
}
act('close', () => $('#dialog').close());
function put(html) { $('#content').innerHTML = html; }
/** Widget banner: a cursor-tracking dot field card plus animated counters. stats: [label, value, icon, hint, percent?] */
function widgets(heading, text, stats) {
    return '<div class="widgets"><div class="wg scene"><div><b>' + E(heading) + '</b><br><small>' + E(text) + '</small></div><canvas class="mini3d" aria-hidden="true"></canvas></div>' +
        stats.map(([label, value, icon, hint, pct]) => '<div class="wg"><span class="ic">' + ico(icon) + '</span><div><div class="num" data-count="' + (parseInt(value, 10) || 0) + '">0</div><small>' + E(label) + (hint ? ' · ' + E(hint) : '') + '</small>' +
            (pct !== undefined ? '<div class="bar"><i data-w="' + Math.max(0, Math.min(100, pct)) + '"></i></div>' : '') + '</div></div>').join('') + '</div>';
}
/** Bring new content to life: count-up numbers, progress bars, mini 3D scenes. */
function animateWidgets(root = document) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelectorAll('[data-count]:not([data-done])').forEach(el => {
        el.dataset.done = 1;
        const to = +el.dataset.count, t0 = performance.now(), dur = 900 + Math.min(900, to * 8);
        if (reduce || !to) { el.textContent = to; return; }
        const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e); if (k < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
    });
    root.querySelectorAll('.bar i[data-w]').forEach(el => requestAnimationFrame(() => requestAnimationFrame(() => { el.style.setProperty('--w', el.dataset.w + '%'); })));
    if (window.Tracker) root.querySelectorAll('canvas.mini3d:not([data-live])').forEach(c => {
        c.dataset.live = 1;
        Tracker.field(c, { gap: 18, radius: 90 });
    });
}
new MutationObserver(() => animateWidgets($('#content'))).observe($('#content'), { childList: true, subtree: true });
function fieldUI(k, label, value = '', type = 'text', options = null) {
    return '<label class="field">' + E(label) + (options ? '<select name="' + E(k) + '">' + options.map(o => '<option ' + (String(value) === String(o) ? 'selected' : '') + '>' + E(o) + '</option>').join('') + '</select>' : '<input type="' + type + '" name="' + E(k) + '" value="' + E(value) + '">') + '</label>';
}
async function refresh() {
    data = await api('overview');
    zone = data.timezone || 'Asia/Kolkata';
}
function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

document.addEventListener('click', async ev => {
    let el = ev.target.closest('[data-action]');
    if (!el) return;
    const [key, ...args] = el.dataset.action.split('|');
    if (!ops[key]) return;
    el.disabled = true;
    try {
        await ops[key](...args);
    } catch (e) {
        notice(e.message);
        if ($('#dialog').open) {
            let p = $('#modal .error');
            if (!p) {
                p = document.createElement('p');
                p.className = 'error';
                $('#modal').append(p);
            }
            p.textContent = e.message;
        }
    } finally {
        el.disabled = false;
    }
});

$('#nav').innerHTML = '<div class="nav-label">WORKSPACE</div>' + nav.map(([n, i]) => btn(n, 'go|' + n, 'nav', i)).join('') + '<div class="nav-label">ACCOUNT</div>' + btn('Sign out', 'logout', 'nav', 'logout');
act('logout', async () => {
    await api('logout');
    location.reload();
});
$('#menu').onclick = () => $('#sidebar').classList.toggle('open');
document.addEventListener('click', e => {
    if (!e.target.closest('#sidebar,#menu')) $('#sidebar').classList.remove('open');
});

$('#profileBtn').onclick = () => profile();
$('#bell').onclick = () => modal('Recent notifications', renderNotifications(data.notifications || []));

function profile() {
    modal('Workspace profile', table(['Name', 'Department', 'Role', 'Email'], [[E(userName), E(dept), isAdmin ? 'Administrator' : 'Staff', E(document.body.dataset.email)]]) + btn('Sign out', 'logout'));
}

function renderNotifications(notifs) {
    return notifs.length ? '<div class="timeline">' + notifs.map(n => `
        <article>
            <small>${E(time(n.created_at))}</small>
            <b>${E(n.title)}</b> · ${E(n.message)}
        </article>
    `).join('') + '</div>' : '<p class="empty">No notifications yet.</p>';
}

function timeline(es) {
    return es.length ? '<div class="timeline">' + es.map(e => '<article><small>' + E(time(e.at)) + ' · ' + E(e.staff) + '</small><b>' + E(e.action) + '</b> · ' + E(e.detail) + (e.session_id ? ' ' + btn('Session ' + e.session_id, 'open|' + e.session_id + '|' + (e.version_id || 0)) : '') + '</article>').join('') + '</div>' : '<p class="empty">No activity in this period.</p>';
}

function sessionTable(list) {
    return table(['Session', 'Staff / Department', 'Subject / Batch', 'Semester', 'Students / Items', 'Mode', 'Generated', 'Status', 'Version', ''], list.map(s => ['<b>' + E(s.meta.title || 'Untitled draft') + '</b><small>#' + s.id + '</small>', E(s.staff) + '<small>' + E(s.meta.department) + '</small>', E(s.meta.subject) + '<small>' + E(s.meta.batch) + '</small>', E(s.meta.semester), s.n + ' / ' + s.itemCount, E(s.mode || '—'), E(time(s.completed)), badge(s.status), E(s.version || '—'), btn('Open', 'open|' + s.id)]), 'Your saved sessions will appear here.');
}

function pemsExamTable(list) {
    return table(['Examination Title', 'Subject & Code', 'Department', 'Batches / Students', 'Status', 'Last Updated', 'Actions'], list.slice(0, 5).map(e => [
        `<b>${E(e.title)}</b><small>#${e.id} · ${E(e.exam_type)}</small>`,
        `${E(e.subject_name)}<small>${E(e.subject_code)} · Sem ${E(e.semester)}</small>`,
        `${E(e.department)}<small>${E(e.programme)}</small>`,
        `<span class="badge">${e.batch_count} Batches</span> <small>${e.total_students} Students</small>`,
        badge(e.status),
        time(e.updated_at),
        btn('Open', `pems_open_exam|${e.id}`)
    ]), 'No practical examinations created yet.');
}

function overviewPage() {
    let s = data.sessions || [];
    let people = data.people || [];
    let pemsExams = data.pems_examinations || [];
    let totalPemsStudents = pemsExams.reduce((sum, e) => sum + Number(e.total_students || 0), 0);
    let today = localDay();
    let generated = (data.events || []).filter(e => ['Generated', 'Regenerated', 'Allocations Generated'].includes(e.action));

    let stats = isAdmin ? [
        ['Staff accounts', people.length, 'person'],
        ['Examinations', pemsExams.length, 'layers'],
        ['Total Students', totalPemsStudents, 'person'],
        ['Active Staff', people.filter(p => +p.active).length, 'check'],
        ['Generated today', generated.filter(e => localDay(e.at) === today).length, 'calendar'],
        ['This month', generated.filter(e => localDay(e.at).slice(0, 7) === today.slice(0, 7)).length, 'calendar']
    ] : [
        ['Practical Examinations', pemsExams.length, 'layers'],
        ['Total Students Enrolled', totalPemsStudents, 'person'],
        ['Draft Examinations', pemsExams.filter(r => r.status === 'Draft').length, 'file'],
        ['Finalized Examinations', pemsExams.filter(r => r.status === 'Finalized').length, 'shield'],
        ['Allocations Generated', pemsExams.filter(r => r.generation_count > 0).length, 'check'],
        ['Centre Code', data.settings?.centre_no || '209', 'layers']
    ];

    put(
        '<section class="hero"><div><div class="eyebrow"><i></i>' + (isAdmin ? 'ADMINISTRATOR OVERVIEW' : 'PSG PRACTICAL EXAMINATIONS') + '</div><h1>Welcome, ' + E(userName.split(' ')[0]) + '.</h1><p>' + E(dept) + ' · ' + (isAdmin ? 'Practical Examination Monitoring & Control' : 'PSG Practical Examination Management System') + '</p>' + btn(isAdmin ? 'Manage Staff' : 'New Examination', isAdmin ? 'go|Staff Management' : 'pems_new_exam', 'primary', 'plus') + '</div><div class="drawing"><canvas class="mini3d" data-zoom="1.5"></canvas></div></section>' +
        statList(stats) +
        '<div class="tiles">' +
        (isAdmin ? [
            ['All Examinations', 'go|Examinations', 'layers'],
            ['Staff Directory', 'go|Staff Directory', 'book'],
            ['Examination Calendar', 'go|Calendar', 'calendar'],
            ['Audit Logs', 'go|Audit Logs', 'shield'],
            ['System Settings', 'go|Settings', 'settings']
        ] : [
            ['Create Examination', 'pems_new_exam', 'plus'],
            ['My Examinations', 'go|Examinations', 'layers'],
            ['Syllabus Library', 'newLib', 'book'],
            ['Official Exports', 'go|My Exports', 'download']
        ]).map(([n, k, i]) => btn(n, k.startsWith('pems_') ? k : 'go|' + k, 'tile', i)).join('') +
        '</div>' +
        card('Current Practical Examinations', pemsExamTable(pemsExams), btn('View all', 'go|Examinations')) +
        card('Recent Activity', timeline((data.events || []).slice(0, 5)))
    );

}

async function go(n) {
    if ($('#dialog').open) $('#dialog').close();
    page = n;
    $('#crumb').textContent = n;
    $('#sidebar').classList.remove('open');
    $$('.nav').forEach(b => b.classList.toggle('active', b.textContent === n));
    await refresh();

    if (n === 'Overview') overviewPage();
    else if (n === 'Examinations' || n === 'All Examinations') PEMS.renderExamsList();
    else if (n === 'New Examination') PEMS.startWizard(0);
    else if (n === 'Attendance Sheets') ATT.list();
    else if (n === 'New Generation') startWizard();
    else if (n === 'All Generations' || n === 'My Generations') historyView();
    else if (n === 'Syllabus Library') libraryView();
    else if (n === 'Staff Directory') staffDirectoryView();
    else if (n === 'Profile') {
        put(title(n) + card('Account', E(userName) + ' · ' + E(dept) + ' · ' + E(document.body.dataset.email), btn('Sign out', 'logout')));
    } else monitor(n);
}
act('go', go);

function historyView() {
    const keys = ['staff', 'department', 'subject', 'batch', 'semester', 'academicYear', 'status', 'mode'];
    put(title(page) + card('Generation sessions', '<div class="filters">' + keys.map(k => fieldUI(k, ({ academicYear: 'Academic year' })[k] || k[0].toUpperCase() + k.slice(1), 'All', 'text', ['All', ...new Set(data.sessions.map(s => s[k] ?? s.meta[k]).filter(Boolean))])).join('') + fieldUI('from', 'From', '', 'date') + fieldUI('to', 'Through', '', 'date') + '</div><div id="results"></div>'));
    function filter() {
        const v = Object.fromEntries($$('.filters [name]').map(e => [e.name, e.value]));
        $('#results').innerHTML = sessionTable(data.sessions.filter(s => keys.every(k => v[k] === 'All' || String(s[k] ?? s.meta[k]) === v[k]) && (!v.from || localDay(s.completed || s.created) >= v.from) && (!v.to || localDay(s.completed || s.created) <= v.to)));
    }
    $$('.filters [name]').forEach(e => e.oninput = filter);
    filter();
}

act('open', async (id, vid = 0) => {
    if ($('#dialog').open) $('#dialog').close();
    const s = await api('session', { id, vid });
    if (s.selected) await preview(s);
    else if (!isAdmin) startWizard({ ...s.draft, id: s.id });
    else modal('Draft session', table(['Field', 'Value'], Object.entries(s.draft.meta).map(([k, v]) => [E(k), E(v)])) + card('Student roster', table(['Roll', 'Name'], (s.draft.students || []).map(r => [E(r.roll), E(r.name)]))) + card('Syllabus', table(['Question', 'Topic'], (s.draft.items || []).map(r => [E(r.num), E(r.topic)]))));
});

act('report', async () => {
    download(await api('report', {}, true), 'monitoring.csv');
    notice('Monitoring report prepared.');
});
