// detail.js — read-only record view: safe to hand to a doctor. Photos full-size.

import { get } from './db.js';
import { esc, fmtDate, TYPES, ICONS } from './fmt.js';
import { getPhotosForRecord, openViewer, openPdfExternal, isPdf } from './photos.js';

function row(label, value) {
  if (!value) return '';
  return `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
}

export async function recordDetailView(app, recordId) {
  const record = await get('records', recordId);
  if (!record) { location.hash = '#/'; return; }
  const member = await get('members', record.memberId);
  const t = TYPES[record.type] || TYPES.symptom;
  document.getElementById('topbar-title').textContent = t.label;
  document.getElementById('btn-back').hidden = false;
  document.getElementById('btn-home').hidden = false;
  document.title = `${t.label} · Family Health Tracker`;

  const attachments = await getPhotosForRecord(recordId);
  const photos = attachments.filter((p) => !isPdf(p.blob));
  const pdfs = attachments.filter((p) => isPdf(p.blob));
  const objectUrls = [];
  const photoGrid = photos.map((p, i) => {
    const url = URL.createObjectURL(p.blob);
    objectUrls.push(url);
    return `<img class="detail-photo" data-i="${i}" src="${url}" alt="Attached photo ${i + 1}">`;
  }).join('');
  const pdfList = pdfs.map((p, i) =>
    `<button type="button" class="detail-pdf" data-i="${i}"><span class="pdf-badge">PDF</span><span class="pdf-name">${esc(p.name || 'Report')}</span></button>`).join('');
  window.addEventListener('hashchange', () => objectUrls.forEach((u) => URL.revokeObjectURL(u)), { once: true });

  let typeRows = '';
  if (record.type === 'symptom') {
    typeRows = row('Resolved', record.resolvedDate ? fmtDate(record.resolvedDate) : '<span class="badge badge-ongoing">Ongoing</span>');
  } else if (record.type === 'visit') {
    typeRows = `
      ${row('Doctor', record.doctorName ? `Dr. ${esc(record.doctorName)}` : '')}
      ${row('Specialty', esc(record.specialty || '') || '')}
      ${row('Diagnosis', esc(record.diagnosis || '') || '')}`;
  } else if (record.type === 'medication') {
    typeRows = `
      ${row('Dosage', esc(record.dosage || '') || '')}
      ${row('Frequency', esc(record.frequency || '') || '')}
      ${row('Until', record.endDate ? fmtDate(record.endDate) : '<span class="badge badge-active">Active</span>')}
      ${row('Prescribed by', record.doctorName ? `Dr. ${esc(record.doctorName)}` : '')}`;
  } else if (record.type === 'lab') {
    typeRows = `
      ${row('Lab', esc(record.labName || '') || '')}
      ${row('Ordered by', record.doctorName ? `Dr. ${esc(record.doctorName)}` : '')}`;
  }

  app.innerHTML = `
    <section class="detail type-${t.cls}">
      <div class="detail-head">
        <span class="record-dot detail-dot" aria-hidden="true">${ICONS[record.type] || ''}</span>
        <div>
          <h2 class="detail-title">${esc(record.title)}</h2>
          <p class="detail-meta">${member ? esc(member.name) + ' · ' : ''}${fmtDate(record.date)}</p>
        </div>
      </div>
      <div class="detail-card">
        ${typeRows}
        ${record.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value detail-notes">${esc(record.notes)}</span></div>` : ''}
      </div>
      ${photos.length ? `<p class="section-heading">Photos</p><div class="detail-photos">${photoGrid}</div>` : ''}
      ${pdfs.length ? `<p class="section-heading">Documents</p><div class="detail-pdfs">${pdfList}</div>` : ''}
      <a class="btn btn-primary btn-block" href="#/record/${esc(recordId)}/edit">Edit record</a>
    </section>`;

  app.querySelectorAll('.detail-photo').forEach((img) => {
    img.addEventListener('click', () => openViewer(photos.map((p) => p.blob), Number(img.dataset.i)));
  });
  app.querySelectorAll('.detail-pdf').forEach((btn) => {
    btn.addEventListener('click', () => openPdfExternal(pdfs[Number(btn.dataset.i)].blob));
  });
}
