'use strict';

function monitor(n) {
    if (n === 'Staff Management') {
        staffList();
        return;
    }
    if (n === 'Calendar') {
        calendarView();
        return;
    }
    if (n === 'Analytics') {
        pemsAnalytics();
        return;
    }
    if (n === 'Settings') {
        settingsView();
        return;
    }
    if (n === 'Audit Logs') {
        auditLogsView();
        return;
    }
    if (['Export History', 'My Exports'].includes(n)) {
        put(
            title(n, 'Prepared documents and official exports.') +
            card('Export Archive', table(
                ['Timestamp', 'Staff', 'Session / Exam', 'Version', 'Format', 'Status', ''],
                data.exports.map(x => [
                    E(time(x.at)),
                    E(x.staff),
                    '#' + (x.session_id || x.exam_id || 1),
                    x.version,
                    E(x.format.toUpperCase()),
                    badge(x.status),
                    btn('Open', 'open|' + x.session_id + '|' + (x.version_id || 0))
                ]),
                'No export records found.'
            ))
        );
        return;
    }

    // Activity timeline view
    put(
        title(n, 'Logged activity across all authorized faculty.') +
        card('Activity timeline', `
            <div class="filters">
                ${fieldUI('from', 'From', '', 'date')}
                ${fieldUI('to', 'Through', '', 'date')}
                ${fieldUI('actor', 'Staff', 'All', 'text', ['All', ...new Set(data.events.map(e => e.staff))])}
                ${fieldUI('action', 'Action', 'All', 'text', ['All', ...new Set(data.events.map(e => e.action))])}
            </div>
            <div id="timeline"></div>
        `)
    );

    function update() {
        let get = k => $('[name=' + k + ']').value;
        $('#timeline').innerHTML = timeline(
            data.events.filter(e =>
                (!get('from') || localDay(e.at) >= get('from')) &&
                (!get('to') || localDay(e.at) <= get('to')) &&
                (get('actor') === 'All' || e.staff === get('actor')) &&
                (get('action') === 'All' || e.action === get('action'))
            )
        );
    }
    $$('.filters [name]').forEach(e => e.oninput = update);
    update();
}

// -------------------------------------------------------------
// SETTINGS VIEW (Institution, Centre 209, Timezone, Marks, etc.)
// -------------------------------------------------------------
function settingsView() {
    const s = data.settings || {};
    put(
        title('System Settings', 'Administrator-controlled institutional configuration for PSG Polytechnic College.') +
        card('Institution & Examination Defaults', `
            <div class="fields" id="settingsFields">
                ${fieldUI('institution_name', 'Institution Name', s.institution_name || 'PSG Polytechnic College')}
                ${fieldUI('institution_short_name', 'Institution Short Name', s.institution_short_name || 'PSG Tech / PSGPTC')}
                ${fieldUI('centre_no', 'Examination Centre Number', s.centre_no || '209')}
                ${fieldUI('centre_name', 'Examination Centre Name', s.centre_name || 'PSG Polytechnic College Examination Centre')}
                ${fieldUI('default_academic_year', 'Default Academic Year', s.default_academic_year || '2023-2024')}
                ${fieldUI('default_max_marks', 'Default Maximum Marks', s.default_max_marks || 75, 'number')}
                ${fieldUI('default_duration', 'Default Examination Duration', s.default_duration || '3 hrs.')}
                ${fieldUI('timezone', 'Display Timezone', s.timezone || 'Asia/Kolkata', 'text', ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'])}
            </div>
            <label class="field" style="margin-top:14px">
                Institution Postal Address
                <textarea name="institution_address">${E(s.institution_address || 'Avinashi Road, Peelamedu, Coimbatore - 641004, Tamil Nadu, India')}</textarea>
            </label>
            <div class="actions">
                ${btn('Save Settings', 'pems_commit_settings', 'primary')}
            </div>
        `)
    );
}

act('pems_commit_settings', async () => {
    const d = Object.fromEntries($$('#settingsFields input, #settingsFields select, [name=institution_address]').map(e => [e.name, e.value]));
    await api('pems_save_settings', d);
    notice('Institution settings updated successfully.');
    await go('Settings');
});

// -------------------------------------------------------------
// AUDIT LOGS VIEW
// -------------------------------------------------------------
async function auditLogsView() {
    const res = await api('pems_audit_logs', { limit: 100 });
    const logs = res.logs || [];

    const rows = logs.map(l => [
        time(l.created_at),
        `<b>${E(l.user_name || 'System')}</b><small>${E(l.user_role)} · ${E(l.ip || '127.0.0.1')}</small>`,
        `<span class="badge">${E(l.action)}</span>`,
        `${E(l.entity_type)} #${l.entity_id || '—'}`,
        E(l.detail)
    ]);

    put(
        title('Audit Logs', 'Immutable server-side audit logs recording authentication, examinations, allocations and exports.') +
        card('Audit Trail (Recent 100 Events)', table(['Timestamp', 'User', 'Action', 'Entity', 'Detail'], rows, 'No audit logs recorded yet.'))
    );
}

// -------------------------------------------------------------
// STAFF DIRECTORY (Reusable Faculty, Examiners & Invigilators)
// -------------------------------------------------------------
function staffDirectoryView() {
    const list = data.staff_directory || [];
    const rows = list.map(p => [
        `<b>${E(p.name)}</b><small>${E(p.employee_id || '—')} · ${E(p.email || '')}</small>`,
        E(p.designation),
        E(p.department),
        E(p.institution),
        `<span class="badge">${E(p.role_type.toUpperCase())}</span>`,
        btn('Edit', `editStaffDir|${p.id}`)
    ]);

    put(
        title('Staff & Examiner Directory', 'Reusable faculty profiles for internal examiners, external examiners, and invigilators.', btn('Add Profile', 'editStaffDir|0', 'primary', 'plus')) +
        card('Directory Profiles', table(['Name / Emp ID', 'Designation', 'Department', 'Institution', 'Role Type', 'Actions'], rows, 'No staff directory profiles saved.'))
    );
}

act('editStaffDir', id => {
    const p = (data.staff_directory || []).find(x => x.id == id) || {};
    modal(id ? 'Edit Staff Profile' : 'Add Staff Profile', `
        <div class="fields" id="staffDirFields">
            ${fieldUI('name', 'Full Name', p.name || '')}
            ${fieldUI('designation', 'Designation', p.designation || '')}
            ${fieldUI('department', 'Department', p.department || '')}
            ${fieldUI('employee_id', 'Employee ID', p.employee_id || '')}
            ${fieldUI('institution', 'Institution', p.institution || 'PSG Polytechnic College')}
            ${fieldUI('role_type', 'Profile Role', p.role_type || 'general', 'text', ['internal', 'external', 'invigilator', 'general'])}
            ${fieldUI('email', 'Email Address', p.email || '', 'email')}
            ${fieldUI('phone', 'Phone Number', p.phone || '')}
        </div>
        <div class="actions">
            ${btn('Save Profile', `commitStaffDir|${id}`, 'primary')}
        </div>
    `);
});

act('commitStaffDir', async id => {
    const d = Object.fromEntries($$('#staffDirFields input, #staffDirFields select').map(e => [e.name, e.value]));
    await api('pems_staff_directory', { ...d, id });
    $('#dialog').close();
    notice('Staff profile saved.');
    await go('Staff Directory');
});

// -------------------------------------------------------------
// ANALYTICS VIEW
// -------------------------------------------------------------
async function pemsAnalytics() {
    const res = await api('pems_admin_analytics');
    const kpis = res.kpis || {};

    const statItems = [
        ['Total Examinations', kpis.total_exams, 'layers'],
        ['Total Batches', kpis.total_batches, 'layers'],
        ['Students Processed', kpis.total_students, 'person'],
        ['Generations Executed', kpis.total_generations, 'chart'],
        ['Official Documents Exported', kpis.total_exports, 'download']
    ];

    const deptRows = (res.by_department || []).map(d => [
        `<b>${E(d.department)}</b>`,
        d.exam_count,
        d.student_count
    ]);

    const statusRows = (res.by_status || []).map(s => [
        badge(s.status),
        s.count
    ]);

    const recentGenRows = (res.recent_generations || []).map(g => [
        time(g.completed_at),
        `<b>${E(g.exam_title)}</b>`,
        E(g.batch_code),
        E(g.staff_name),
        `${g.student_count} students`,
        `<span class="badge">${E(g.mode)}</span>`
    ]);

    put(
        title('System Analytics', 'Real-time database metrics across departments, examinations, and student allocations.') +
        statList(statItems) +
        '<div style="display:grid; grid-template-columns: 2fr 1fr; gap:16px">' +
        card('Examinations by Department', table(['Department', 'Examinations', 'Students'], deptRows)) +
        card('Status Breakdown', table(['Status', 'Count'], statusRows)) +
        '</div>' +
        card('Recent Sub-Question Generations', table(['Timestamp', 'Examination', 'Batch', 'Staff', 'Students', 'Mode'], recentGenRows))
    );
}

// -------------------------------------------------------------
// STAFF ACCOUNTS
// -------------------------------------------------------------
function staffList() {
    put(
        title('Staff management', 'Authorized workspace accounts for faculty members.', btn('Create staff account', 'editUser', 'primary', 'plus')) +
        card('Staff directory', table(
            ['Staff', 'Department', 'Login', 'Last login', 'Sessions', 'Students', 'Last generation', 'Last activity', 'Account', ''],
            data.people.map(p => {
                let sessions = data.sessions.filter(s => s.owner == p.id);
                return [
                    E(p.name) + '<small>#' + p.id + ' · ' + E(p.email) + '</small>',
                    E(p.department),
                    +p.online ? 'Online' : 'Offline',
                    E(time(p.last_login)),
                    sessions.length,
                    sessions.reduce((a, s) => a + Number(s.n), 0),
                    E(time(sessions.map(s => s.completed).filter(Boolean).sort().pop())),
                    E(time(p.last_activity)),
                    badge(+p.active ? 'Active' : 'Inactive'),
                    btn('Edit', 'editUser|' + p.id) + btn('History', 'staffHistory|' + p.id)
                ];
            }),
            'Create a staff account to grant workspace access.'
        ))
    );
}

act('staffHistory', id => {
    let p = data.people.find(x => x.id == id);
    modal(p.name, card('Generation history', sessionTable(data.sessions.filter(s => s.owner == id))) + card('Activity and exports', timeline(data.events.filter(e => e.actor == id))));
});

act('editUser', (id = '') => {
    let p = data.people.find(x => x.id == id) || {};
    modal(id ? 'Edit staff account' : 'Create staff account', `
        <div class="fields" id="staffFields">
            ${fieldUI('name', 'Full name', p.name)}
            ${fieldUI('email', 'Institutional email', p.email, 'email')}
            ${fieldUI('department', 'Department', p.department)}
            ${fieldUI('password', id ? 'Reset password (optional, 14+ characters)' : 'Initial password (14+ characters)', '', 'password')}
        </div>
        ${id ? '<p><label><input id="active" type="checkbox" ' + (+p.active ? 'checked' : '') + '> Active account</label></p>' : ''}
        <div class="actions">
            ${btn('Save account', 'commitStaff|' + id, 'primary')}
        </div>
    `);
});

act('commitStaff', async id => {
    let d = Object.fromEntries($$('#staffFields input').map(e => [e.name, e.value]));
    await api('user', { ...d, id, active: $('#active')?.checked ?? true });
    await go('Staff Management');
    notice('Staff account saved.');
});

// -------------------------------------------------------------
// CALENDAR VIEW (Asia/Kolkata timezone)
// -------------------------------------------------------------
let calDate, calMode = 'Month';
function dateShift(d, n) {
    let x = new Date(d + 'T12:00:00Z');
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
}

async function calendarView() {
    calDate = calDate || localDay();
    put(
        title('Examination Calendar', 'Duty schedules, batch examination timings and laboratory assignments in ' + zone + '.') +
        card('Calendar', `
            <div class="toolbar">
                ${btn('Previous', 'calMove|-1')}
                ${btn('Today', 'calToday')}
                ${btn('Next', 'calMove|1')}
                <input type="date" id="calDate" value="${calDate}" aria-label="Calendar date">
                <select class="picker" id="calMode" aria-label="Calendar view">
                    ${['Month', 'Week', 'Day', 'Agenda'].map(x => '<option ' + (x === calMode ? 'selected' : '') + '>' + x + '</option>').join('')}
                </select>
            </div>
            <div id="calendar">Loading calendar events...</div>
        `)
    );

    $('#calDate').onchange = e => {
        if (e.target.value) {
            calDate = e.target.value;
            renderCalendar();
        }
    };
    $('#calMode').onchange = e => {
        calMode = e.target.value;
        renderCalendar();
    };

    await renderCalendar();
}

act('calToday', () => {
    calDate = localDay();
    calendarView();
});

act('calMove', i => {
    if (['Month', 'Agenda'].includes(calMode)) {
        let d = new Date(calDate.slice(0, 7) + '-01T12:00:00Z');
        d.setUTCMonth(d.getUTCMonth() + Number(i));
        calDate = d.toISOString().slice(0, 10);
    } else {
        calDate = dateShift(calDate, i * (calMode === 'Day' ? 1 : 7));
    }
    calendarView();
});

async function renderCalendar() {
    let calRes = await api('pems_admin_calendar');
    let events = calRes.events || [];

    let dow = d => (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const dayEvents = d => events.filter(e => e.date === d);

    function item(e) {
        return `
            <button class="event ${E(e.status)}" data-action="pems_open_exam|${e.exam_id}">
                <span>
                    <b>${E(e.title)}</b> (${e.student_count} Students)
                    <small>${E(e.subject)} · ${E(e.room)} · ${E(e.start_time)}</small>
                    <small>Invigilator: ${E(e.invigilator || 'Unassigned')} · ${E(e.status)}</small>
                </span>
            </button>
        `;
    }

    let container = $('#calendar');
    if (!container) return;

    if (calMode === 'Day' || calMode === 'Agenda') {
        let arr = calMode === 'Day' ? dayEvents(calDate) : events.filter(e => e.date.slice(0, 7) === calDate.slice(0, 7));
        container.innerHTML = arr.map(item).join('') || '<p class="empty">No examination events scheduled during this period.</p>';
        return;
    }

    let first = calDate.slice(0, 7) + '-01';
    let start = calMode === 'Week' ? dateShift(calDate, -dow(calDate)) : dateShift(first, -dow(first));
    let days = calMode === 'Week' ? 7 : Math.ceil((dow(first) + new Date(Date.UTC(+first.slice(0, 4), +first.slice(5, 7), 0)).getUTCDate()) / 7) * 7;

    container.innerHTML = '<div class="days">' +
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => '<div class="weekhead">' + x + '</div>').join('') +
        Array.from({ length: days }, (_, i) => {
            let d = dateShift(start, i);
            return '<div class="day"><b>' + Number(d.slice(-2)) + '</b>' + dayEvents(d).map(item).join('') + '</div>';
        }).join('') +
        '</div>';
}

go(isAdmin ? 'Overview' : 'Examinations').catch(e => {
    put(title('Workspace unavailable', e.message, btn('Retry', 'go|Overview')));
});
