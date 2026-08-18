// vaccines.js — per-member vaccination list: given / due / overdue, form, report summary.

import { uuid, put, del, get, getVaccinesFor } from './db.js';
import { esc, fmtDate, todayStr } from './fmt.js';

function isOverdue(v) {
  return !v.dateGiven && v.dueDate && v.dueDate < todayStr();
}

// Due/overdue first (soonest due first, undated last), then given (newest first).
export function sortVaccines(vaccines) {
  const due = vaccines.filter((v) => !v.dateGiven)
    .sort((a, b) => (a.dueDate || '￿').localeCompare(b.dueDate || '￿'));
  const given = vaccines.filter((v) => v.dateGiven)
    .sort((a, b) => b.dateGiven.localeCompare(a.dateGiven));
  return [...due, ...given];
}

function vaccineTitle(v) {
  return `${esc(v.name)}${v.doseLabel ? ` (${esc(v.doseLabel)})` : ''}`;
}

export async function vaccinesView(app, memberId, editingId = null) {
  const member = await get('members', memberId);
  if (!member) { location.hash = '#/'; return; }
  document.getElementById('topbar-title').textContent = `Vaccines — ${member.name}`;
  document.getElementById('btn-back').hidden = false;
  document.getElementById('btn-home').hidden = false;
  document.title = `Vaccines — ${member.name} · Family Health Tracker`;

  const vaccines = sortVaccines(await getVaccinesFor(memberId));
  const editing = editingId ? vaccines.find((v) => v.id === editingId) : null;
  const v = (k) => esc(editing?.[k] ?? '');

  const rows = vaccines.map((vac) => {
    const status = vac.dateGiven
      ? `<span class="badge badge-active">Given ${fmtDate(vac.dateGiven)}</span>`
      : (isOverdue(vac)
        ? `<span class="badge badge-overdue">Overdue ${fmtDate(vac.dueDate)}</span>`
        : `<span class="badge badge-ongoing">Due${vac.dueDate ? ` ${fmtDate(vac.dueDate)}` : ''}</span>`);
    return `
      <li class="vaccine-row${editing && editing.id === vac.id ? ' vaccine-row-editing' : ''}" data-id="${esc(vac.id)}">
        <button type="button" class="vaccine-body" aria-label="Edit ${esc(vac.name)}">
          <span class="vaccine-name">${vaccineTitle(vac)}</span>
          ${vac.batchLot ? `<span class="vaccine-lot">Lot ${esc(vac.batchLot)}</span>` : ''}
          ${vac.notes ? `<span class="vaccine-notes">${esc(vac.notes)}</span>` : ''}
        </button>
        ${status}
        <button type="button" class="vaccine-del" aria-label="Delete vaccine entry">&#10005;</button>
      </li>`;
  }).join('');

  app.innerHTML = `
    <section class="vaccines">
      <form class="form vital-form" id="vaccine-form">
        <p class="section-heading">${editing ? 'Edit entry' : 'Add a vaccine'}</p>
        ${'' /* name + dose */}
        <label class="field"><span class="field-label">Vaccine name <span class="req">*</span></span>
          <input name="name" required maxlength="80" value="${v('name')}" placeholder="e.g., MMR" autocomplete="off"></label>
        <div class="vital-pair">
          <label class="field"><span class="field-label">Dose (optional)</span>
            <input name="doseLabel" maxlength="40" value="${v('doseLabel')}" placeholder="e.g., Dose 2, Booster"></label>
          <label class="field"><span class="field-label">Batch/Lot (optional)</span>
            <input name="batchLot" maxlength="40" value="${v('batchLot')}"></label>
        </div>
        <div class="vital-pair">
          <label class="field"><span class="field-label">Date given (empty = due)</span>
            <input type="date" name="dateGiven" value="${v('dateGiven')}"></label>
          <label class="field"><span class="field-label">Due date (optional)</span>
            <input type="date" name="dueDate" value="${v('dueDate')}"></label>
        </div>
        <label class="field"><span class="field-label">Notes</span>
          <input name="notes" maxlength="200" value="${v('notes')}" placeholder="Clinic, reactions, ..."></label>
        <p class="error" id="vaccine-error" hidden></p>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add vaccine'}</button>
          ${editing ? '<button class="btn btn-ghost" type="button" id="vaccine-cancel">Cancel</button>' : ''}
        </div>
      </form>
      ${vaccines.length
        ? `<ul class="vital-list">${rows}</ul>`
        : `<div class="empty"><p>No vaccine entries yet for ${esc(member.name)} — add the first one above.</p></div>`}
    </section>`;

  app.querySelector('#vaccine-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: editing?.id || uuid(),
      memberId,
      name: f.get('name').trim(),
      doseLabel: f.get('doseLabel').trim(),
      batchLot: f.get('batchLot').trim(),
      dateGiven: f.get('dateGiven') || '',
      dueDate: f.get('dueDate') || '',
      notes: f.get('notes').trim(),
      createdAt: editing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!obj.name) return;
    try {
      await put('vaccines', obj);
    } catch (err) {
      const errEl = app.querySelector('#vaccine-error');
      errEl.textContent = "Couldn't save — your phone's storage may be full.";
      errEl.hidden = false;
      return;
    }
    vaccinesView(app, memberId);
  });

  const cancelBtn = app.querySelector('#vaccine-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => vaccinesView(app, memberId));

  app.querySelectorAll('.vaccine-body').forEach((btn) => {
    btn.addEventListener('click', () => {
      vaccinesView(app, memberId, btn.closest('.vaccine-row').dataset.id);
      app.querySelector('#vaccine-form')?.scrollIntoView({ block: 'start' });
    });
  });

  app.querySelectorAll('.vaccine-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this vaccine entry?')) return;
      await del('vaccines', btn.closest('.vaccine-row').dataset.id);
      vaccinesView(app, memberId);
    });
  });
}

// For the doctor report: { given: ['12 Aug 2026 — MMR (Dose 2) · Lot X', ...], due: ['Typhoid — due 1 Sep 2026', ...] }
export async function vaccinesSummary(memberId) {
  const vaccines = sortVaccines(await getVaccinesFor(memberId));
  const given = vaccines.filter((v) => v.dateGiven)
    .sort((a, b) => a.dateGiven.localeCompare(b.dateGiven))
    .map((v) => `${fmtDate(v.dateGiven)} — ${v.name}${v.doseLabel ? ` (${v.doseLabel})` : ''}${v.batchLot ? ` · Lot ${v.batchLot}` : ''}`);
  const due = vaccines.filter((v) => !v.dateGiven)
    .map((v) => `${v.name}${v.doseLabel ? ` (${v.doseLabel})` : ''}${v.dueDate ? ` — due ${fmtDate(v.dueDate)}` : ''}`);
  return { given, due };
}
