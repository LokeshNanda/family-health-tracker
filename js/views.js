// views.js — one render function per screen. Every user string passes through esc().

import {
  uuid, get, put, del, getMembers, getRecordsForMember,
  countRecordsForMember, deleteMemberCascade, deleteRecordCascade, getAll,
} from './db.js';
import { exportBackup, lastBackupInfo, parseBackupFile, importBackup } from './backup.js';
import { photoPicker } from './photos.js';
import { latestVitalsSummary } from './vitals.js';

// ---- Shared helpers ----

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format "YYYY-MM-DD" by splitting — never new Date(str), which shifts a day in some timezones.
export function fmtDate(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd || '';
  const [y, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function ageFrom(dob) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return '';
  const [y, m, d] = dob.split('-').map(Number);
  const now = new Date();
  let years = now.getFullYear() - y;
  let months = now.getMonth() + 1 - m;
  if (now.getDate() < d) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return '';
  if (years < 2) return `${years * 12 + months} mo`;
  return `${years} yrs`;
}

const ICONS = {
  symptom: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4a2 2 0 1 0-4 0v9.3a4.5 4.5 0 1 0 4 0V4z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="11" cy="17.5" r="2" fill="currentColor"/></svg>',
  visit: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6.5" width="17" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 6V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10v6M9 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  medication: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="9" width="18" height="7" rx="3.5" transform="rotate(-35 12 12.5)" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="9.2" y1="14.6" x2="14.8" y2="10.4" stroke="currentColor" stroke-width="1.8"/></svg>',
};

export const TYPES = {
  symptom: { label: 'Symptom', plural: 'Symptoms', cls: 'symptom' },
  visit: { label: 'Doctor visit', plural: 'Visits', cls: 'visit' },
  medication: { label: 'Medication', plural: 'Medications', cls: 'medication' },
};

function setTopbar(title, showBack) {
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('btn-back').hidden = !showBack;
  document.title = title === 'Family Health Tracker' ? title : `${title} · Family Health Tracker`;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function hueFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function detailLine(r) {
  const parts = [];
  if (r.type === 'symptom') {
    parts.push(r.resolvedDate
      ? `Resolved ${fmtDate(r.resolvedDate)}`
      : '<span class="badge badge-ongoing">Ongoing</span>');
  } else if (r.type === 'visit') {
    if (r.doctorName) parts.push(`Dr. ${esc(r.doctorName)}${r.specialty ? ` · ${esc(r.specialty)}` : ''}`);
    else if (r.specialty) parts.push(esc(r.specialty));
    if (r.diagnosis) parts.push(esc(r.diagnosis));
  } else if (r.type === 'medication') {
    const dose = [r.dosage, r.frequency].filter(Boolean).map(esc).join(' · ');
    if (dose) parts.push(dose);
    parts.push(r.endDate
      ? `Until ${fmtDate(r.endDate)}`
      : '<span class="badge badge-active">Active</span>');
    if (r.doctorName) parts.push(`Dr. ${esc(r.doctorName)}`);
  }
  return parts.join(' &middot; ');
}

function recordCard(r, opts = {}) {
  const t = TYPES[r.type] || TYPES.symptom;
  const detail = detailLine(r);
  return `
    <li class="record type-${t.cls}">
      <span class="record-dot" aria-hidden="true">${ICONS[r.type] || ''}</span>
      <a class="record-body" href="#/record/${esc(r.id)}/edit" aria-label="Edit ${esc(r.title)}">
        <div class="record-top">
          <span class="record-date">${fmtDate(r.date)}</span>
          <span class="record-type">${t.label}${opts.memberName ? ` · ${esc(opts.memberName)}` : ''}${(r.attachments && r.attachments.length) ? ` <span class="badge badge-photos">&#128206;${r.attachments.length}</span>` : ''}</span>
        </div>
        <div class="record-title">${esc(r.title)}</div>
        ${detail ? `<div class="record-detail">${detail}</div>` : ''}
        ${r.notes ? `<div class="record-notes">${esc(r.notes)}</div>` : ''}
      </a>
    </li>`;
}

function field(label, inner) {
  return `<label class="field"><span class="field-label">${label}</span>${inner}</label>`;
}

// ---- Home ----

export async function homeView(app) {
  setTopbar('Family Health Tracker', false);
  const members = await getMembers();
  const counts = await Promise.all(members.map((m) => countRecordsForMember(m.id)));

  const cards = members.map((m, i) => `
    <li>
      <a class="member-card" href="#/member/${esc(m.id)}">
        <span class="avatar" style="--hue:${hueFor(m.id)}">${esc(initials(m.name))}</span>
        <span class="member-info">
          <span class="member-name">${esc(m.name)}</span>
          <span class="member-meta">${[ageFrom(m.dob), `${counts[i]} record${counts[i] === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>
        </span>
        <span class="chevron" aria-hidden="true">&#8250;</span>
      </a>
    </li>`).join('');

  app.innerHTML = `
    <section class="home">
      ${members.length ? `<ul class="member-list">${cards}</ul>` : `
        <div class="empty">
          <p class="empty-title">Your family's health book is empty.</p>
          <p>Add the people you care for, then record fevers, doctor visits and medicines as they happen.</p>
        </div>`}
      <a class="btn btn-primary btn-block" href="#/member/new">+ Add family member</a>
      ${members.length ? '<a class="btn btn-ghost btn-block" href="#/search">Search all records</a>' : ''}
      <section class="backup-panel">
        <h2 class="section-heading">Backup</h2>
        <p class="backup-nudge">${esc(lastBackupInfo())} — your data lives only on this device.</p>
        <div class="btn-row">
          <button class="btn btn-ghost" id="btn-export">Export backup</button>
          <button class="btn btn-ghost" id="btn-import">Import backup</button>
        </div>
        <input type="file" id="import-file" accept=".json,application/json" hidden>
        <div id="import-panel"></div>
      </section>
    </section>`;

  app.querySelector('#btn-export').addEventListener('click', async () => {
    const res = await exportBackup();
    app.querySelector('.backup-nudge').textContent =
      `Backup saved (${res.members} members, ${res.records} records). Keep the file somewhere safe.`;
  });

  const fileInput = app.querySelector('#import-file');
  app.querySelector('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    const panel = app.querySelector('#import-panel');
    if (!file) return;
    let data;
    try {
      data = await parseBackupFile(file);
    } catch (err) {
      panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      fileInput.value = '';
      return;
    }
    panel.innerHTML = `
      <div class="import-choice">
        <p>This backup holds <strong>${data.members.length}</strong> members and <strong>${data.records.length}</strong> records
        (saved ${esc(new Date(data.exportedAt).toLocaleDateString())}). How should it be imported?</p>
        <div class="btn-row">
          <button class="btn btn-primary" id="btn-merge">Merge with current data</button>
          <button class="btn btn-danger" id="btn-replace">Replace everything</button>
        </div>
      </div>`;
    panel.querySelector('#btn-merge').addEventListener('click', async () => {
      const res = await importBackup(data, 'merge');
      panel.innerHTML = `<p class="success">Imported ${res.members} members and ${res.records} records.</p>`;
      fileInput.value = '';
      setTimeout(() => homeView(app), 900);
    });
    panel.querySelector('#btn-replace').addEventListener('click', async () => {
      if (!confirm('Replace ALL current data with this backup? This cannot be undone.')) return;
      const res = await importBackup(data, 'replace');
      panel.innerHTML = `<p class="success">Restored ${res.members} members and ${res.records} records.</p>`;
      fileInput.value = '';
      setTimeout(() => homeView(app), 900);
    });
  });
}

// ---- Member timeline ----

export async function memberView(app, memberId, filter = 'all') {
  const member = await get('members', memberId);
  if (!member) { location.hash = '#/'; return; }
  setTopbar(member.name, true);
  const records = await getRecordsForMember(memberId);
  const shown = filter === 'all' ? records : records.filter((r) => r.type === filter);

  const chips = [['all', 'All'], ['symptom', TYPES.symptom.plural], ['visit', TYPES.visit.plural], ['medication', TYPES.medication.plural]]
    .map(([key, label]) =>
      `<button class="chip${filter === key ? ' chip-on' : ''}" data-filter="${key}">${label}</button>`).join('');

  const profileChips = [
    member.bloodGroup ? `<span class="pchip">🩸 ${esc(member.bloodGroup)}</span>` : '',
    member.allergies ? `<span class="pchip pchip-alert">Allergies: ${esc(member.allergies)}</span>` : '',
    member.dob ? `<span class="pchip">${fmtDate(member.dob)} (${ageFrom(member.dob)})</span>` : '',
  ].filter(Boolean).join('');

  app.innerHTML = `
    <section class="member">
      ${profileChips ? `<div class="pchips">${profileChips}</div>` : ''}
      <div class="btn-row member-actions no-print">
        <a class="btn btn-ghost btn-sm" href="#/member/${esc(memberId)}/edit">Edit profile</a>
        <a class="btn btn-ghost btn-sm" href="#/member/${esc(memberId)}/vitals">Vitals</a>
        <a class="btn btn-ghost btn-sm" href="#/report/${esc(memberId)}">Doctor report</a>
      </div>
      <div class="chips no-print">${chips}</div>
      ${shown.length
        ? `<ul class="timeline">${shown.map((r) => recordCard(r)).join('')}</ul>`
        : `<div class="empty"><p>${records.length ? 'Nothing of this type yet.' : `No records yet for ${esc(member.name)} — add the first one below.`}</p></div>`}
      <div class="type-picker no-print">
        <p class="section-heading">Add a record</p>
        <div class="btn-row">
          <a class="btn btn-type type-symptom" href="#/member/${esc(memberId)}/record/new/symptom">${ICONS.symptom} Symptom</a>
          <a class="btn btn-type type-visit" href="#/member/${esc(memberId)}/record/new/visit">${ICONS.visit} Visit</a>
          <a class="btn btn-type type-medication" href="#/member/${esc(memberId)}/record/new/medication">${ICONS.medication} Medicine</a>
        </div>
      </div>
      <button class="btn btn-danger-ghost btn-block no-print" id="btn-del-member">Delete ${esc(member.name)}&hellip;</button>
    </section>`;

  app.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => memberView(app, memberId, chip.dataset.filter));
  });
  app.querySelector('#btn-del-member').addEventListener('click', async () => {
    const n = records.length;
    if (!confirm(`Delete ${member.name} and all ${n} of their record${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await deleteMemberCascade(memberId);
    location.hash = '#/';
  });
}

// ---- Member form (new / edit) ----

export async function memberFormView(app, memberId) {
  const member = memberId ? await get('members', memberId) : null;
  if (memberId && !member) { location.hash = '#/'; return; }
  setTopbar(member ? 'Edit profile' : 'New family member', true);
  const v = (k) => esc(member?.[k] ?? '');
  const genders = ['', 'Female', 'Male', 'Other'];
  const bloods = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

  app.innerHTML = `
    <form class="form" id="member-form">
      ${field('Name <span class="req">*</span>', `<input name="name" required maxlength="80" value="${v('name')}" autocomplete="off">`)}
      ${field('Date of birth', `<input type="date" name="dob" value="${v('dob')}">`)}
      ${field('Gender', `<select name="gender">${genders.map((g) => `<option${member?.gender === g ? ' selected' : ''}>${g}</option>`).join('')}</select>`)}
      ${field('Blood group', `<select name="bloodGroup">${bloods.map((b) => `<option${member?.bloodGroup === b ? ' selected' : ''}>${b}</option>`).join('')}</select>`)}
      ${field('Allergies', `<input name="allergies" maxlength="200" value="${v('allergies')}" placeholder="e.g., Penicillin, peanuts">`)}
      ${field('Notes', `<textarea name="notes" rows="3" maxlength="1000">${v('notes')}</textarea>`)}
      <button class="btn btn-primary btn-block" type="submit">${member ? 'Save changes' : 'Add member'}</button>
    </form>`;

  app.querySelector('#member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: member?.id || uuid(),
      name: f.get('name').trim(),
      dob: f.get('dob') || '',
      gender: f.get('gender') || '',
      bloodGroup: f.get('bloodGroup') || '',
      allergies: f.get('allergies').trim(),
      notes: f.get('notes').trim(),
      createdAt: member?.createdAt || new Date().toISOString(),
    };
    if (!obj.name) return;
    await put('members', obj);
    location.hash = `#/member/${obj.id}`;
  });
}

// ---- Record form (new / edit) ----

const TITLE_LABEL = {
  symptom: 'What happened? <span class="req">*</span>',
  visit: 'Reason / diagnosis <span class="req">*</span>',
  medication: 'Medicine name <span class="req">*</span>',
};
const TITLE_HINT = {
  symptom: 'e.g., Fever 101°F',
  visit: 'e.g., Throat infection follow-up',
  medication: 'e.g., Azithromycin',
};
const DATE_LABEL = { symptom: 'When did it start?', visit: 'Visit date', medication: 'Start date' };

export async function recordFormView(app, { memberId, type, recordId }) {
  const record = recordId ? await get('records', recordId) : null;
  if (recordId && !record) { location.hash = '#/'; return; }
  const rType = record?.type || type;
  const rMemberId = record?.memberId || memberId;
  const member = await get('members', rMemberId);
  if (!member) { location.hash = '#/'; return; }
  const t = TYPES[rType];
  setTopbar(record ? `Edit ${t.label.toLowerCase()}` : `${t.label} — ${member.name}`, true);
  const v = (k) => esc(record?.[k] ?? '');
  const today = new Date();
  const todayStr = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');

  let extra = '';
  if (rType === 'symptom') {
    extra = field('Resolved on (leave empty if ongoing)', `<input type="date" name="resolvedDate" value="${v('resolvedDate')}">`);
  } else if (rType === 'visit') {
    extra = `
      ${field('Doctor name', `<input name="doctorName" maxlength="80" value="${v('doctorName')}">`)}
      ${field('Specialty', `<input name="specialty" maxlength="80" value="${v('specialty')}" placeholder="e.g., Pediatrician">`)}
      ${field('Diagnosis', `<input name="diagnosis" maxlength="200" value="${v('diagnosis')}">`)}`;
  } else if (rType === 'medication') {
    extra = `
      ${field('Dosage', `<input name="dosage" maxlength="80" value="${v('dosage')}" placeholder="e.g., 500 mg">`)}
      ${field('Frequency', `<input name="frequency" maxlength="80" value="${v('frequency')}" placeholder="e.g., Once daily after food">`)}
      ${field('End date (leave empty if still taking)', `<input type="date" name="endDate" value="${v('endDate')}">`)}
      ${field('Prescribed by', `<input name="doctorName" maxlength="80" value="${v('doctorName')}">`)}`;
  }

  app.innerHTML = `
    <form class="form" id="record-form">
      ${field(`${DATE_LABEL[rType]} <span class="req">*</span>`, `<input type="date" name="date" required value="${v('date') || todayStr}">`)}
      ${field(TITLE_LABEL[rType], `<input name="title" required maxlength="120" value="${v('title')}" placeholder="${TITLE_HINT[rType]}" autocomplete="off">`)}
      ${extra}
      ${field('Notes', `<textarea name="notes" rows="3" maxlength="2000">${v('notes')}</textarea>`)}
      <div class="field"><span class="field-label">Photos (prescriptions, reports)</span><div id="photo-picker"></div></div>
      <p class="error" id="form-error" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">${record ? 'Save changes' : `Add ${t.label.toLowerCase()}`}</button>
      ${record ? '<button class="btn btn-danger-ghost btn-block" type="button" id="btn-del-record">Delete this record</button>' : ''}
    </form>`;

  const picker = await photoPicker(app.querySelector('#photo-picker'), record?.id || null);

  app.querySelector('#record-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const errEl = app.querySelector('#form-error');
    const date = f.get('date');
    const endish = f.get('resolvedDate') || f.get('endDate') || '';
    if (endish && endish < date) {
      errEl.textContent = 'The end date cannot be before the start date.';
      errEl.hidden = false;
      return;
    }
    const obj = {
      id: record?.id || uuid(),
      memberId: rMemberId,
      type: rType,
      date,
      title: f.get('title').trim(),
      notes: f.get('notes').trim(),
      createdAt: record?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (rType === 'symptom') obj.resolvedDate = f.get('resolvedDate') || '';
    if (rType === 'visit') {
      obj.doctorName = f.get('doctorName').trim();
      obj.specialty = f.get('specialty').trim();
      obj.diagnosis = f.get('diagnosis').trim();
    }
    if (rType === 'medication') {
      obj.dosage = f.get('dosage').trim();
      obj.frequency = f.get('frequency').trim();
      obj.endDate = f.get('endDate') || '';
      obj.doctorName = f.get('doctorName').trim();
    }
    obj.attachments = await picker.commit(obj.id);
    await put('records', obj);
    location.hash = `#/member/${rMemberId}`;
  });

  const delBtn = app.querySelector('#btn-del-record');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this record?')) return;
      await deleteRecordCascade(record.id);
      location.hash = `#/member/${rMemberId}`;
    });
  }
}

// ---- Search ----

const SEARCH_FIELDS = ['title', 'notes', 'doctorName', 'specialty', 'diagnosis', 'dosage', 'frequency'];

export async function searchView(app) {
  setTopbar('Search', true);
  const [records, members] = await Promise.all([getAll('records'), getMembers()]);
  const byId = new Map(members.map((m) => [m.id, m]));

  app.innerHTML = `
    <section class="search">
      <input type="search" id="search-input" class="search-input" placeholder="Try &quot;azithromycin&quot; or a doctor's name&hellip;" autocomplete="off">
      <div id="search-results">
        <p class="hint">Search medicines, symptoms, doctors, diagnoses and notes — across everyone.</p>
      </div>
    </section>`;

  const input = app.querySelector('#search-input');
  const results = app.querySelector('#search-results');
  input.focus();

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), 150);
  });

  function run(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      results.innerHTML = '<p class="hint">Search medicines, symptoms, doctors, diagnoses and notes — across everyone.</p>';
      return;
    }
    const people = members.filter((m) => m.name.toLowerCase().includes(q));
    const hits = records
      .filter((r) => SEARCH_FIELDS.some((k) => (r[k] || '').toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

    let html = '';
    if (people.length) {
      html += `<p class="section-heading">People</p><ul class="member-list">${people.map((m) => `
        <li><a class="member-card" href="#/member/${esc(m.id)}">
          <span class="avatar" style="--hue:${hueFor(m.id)}">${esc(initials(m.name))}</span>
          <span class="member-info"><span class="member-name">${esc(m.name)}</span></span>
          <span class="chevron" aria-hidden="true">&#8250;</span>
        </a></li>`).join('')}</ul>`;
    }
    if (hits.length) {
      html += `<p class="section-heading">${hits.length} record${hits.length === 1 ? '' : 's'} — newest first</p>
        <ul class="timeline">${hits.map((r) => recordCard(r, { memberName: byId.get(r.memberId)?.name || 'Unknown' })).join('')}</ul>`;
    }
    if (!html) html = `<div class="empty"><p>No records match &ldquo;${esc(query.trim())}&rdquo;.</p></div>`;
    results.innerHTML = html;
  }
}

// ---- Doctor report ----

export async function reportView(app, memberId) {
  const member = await get('members', memberId);
  if (!member) { location.hash = '#/'; return; }
  setTopbar('Doctor report', true);
  const records = await getRecordsForMember(memberId);
  const chrono = [...records].reverse(); // oldest → newest for the doctor
  const activeMeds = records.filter((r) => r.type === 'medication' && !r.endDate);
  const vitalLines = await latestVitalsSummary(memberId);
  const today = new Date();
  const generated = `${today.getDate()} ${MONTHS[today.getMonth()]} ${today.getFullYear()}`;

  const byYear = new Map();
  for (const r of chrono) {
    const year = r.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(r);
  }

  const reportRecord = (r) => {
    const t = TYPES[r.type];
    return `
      <div class="report-record">
        <div class="report-record-head">
          <strong>${fmtDate(r.date)}</strong> — ${t.label}: ${esc(r.title)}
        </div>
        ${detailLine(r) ? `<div class="report-record-detail">${detailLine(r)}</div>` : ''}
        ${r.notes ? `<div class="report-record-notes">${esc(r.notes)}</div>` : ''}
      </div>`;
  };

  app.innerHTML = `
    <section class="report">
      <button class="btn btn-primary btn-block no-print" id="btn-print">Print / Save as PDF</button>
      <header class="report-header">
        <h2 class="report-name">${esc(member.name)}</h2>
        <p class="report-meta">
          ${[member.dob ? `Born ${fmtDate(member.dob)} (${ageFrom(member.dob)})` : '', member.gender, member.bloodGroup ? `Blood group ${member.bloodGroup}` : ''].filter(Boolean).map(esc).join(' · ') || 'Health summary'}
        </p>
        ${member.allergies ? `<p class="report-allergies">⚠ Allergies: ${esc(member.allergies)}</p>` : ''}
        <p class="report-generated">Generated ${generated} · Family Health Tracker</p>
      </header>
      ${vitalLines.length ? `
        <h3 class="report-section">Recent vitals</h3>
        <p class="report-vitals">${vitalLines.map(esc).join(' · ')}</p>` : ''}
      ${activeMeds.length ? `
        <h3 class="report-section">Current medications</h3>
        ${activeMeds.map(reportRecord).join('')}` : ''}
      <h3 class="report-section">History</h3>
      ${chrono.length
        ? [...byYear.entries()].map(([year, rs]) => `
            <h4 class="report-year">${year}</h4>
            ${rs.map(reportRecord).join('')}`).join('')
        : '<p class="hint">No records yet.</p>'}
    </section>`;

  app.querySelector('#btn-print').addEventListener('click', () => window.print());
}
