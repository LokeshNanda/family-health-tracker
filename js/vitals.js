// vitals.js — per-member vitals: tabs, SVG line chart, add/edit form, reading list.

import { uuid, put, del, get, getVitalsFor } from './db.js';
import { esc, fmtDate, todayStr } from './fmt.js';

export const VITAL_TYPES = {
  weight: { label: 'Weight', unit: 'kg', fields: 'single' },
  height: { label: 'Height', unit: 'cm', fields: 'single' },
  bp: { label: 'BP', unit: 'mmHg', fields: 'double' },
  sugar: { label: 'Sugar', unit: 'mg/dL', fields: 'single+context' },
  temp: { label: 'Temp', unit: '°F', fields: 'single' },
};

// Timestamp for x-positioning only (relative spacing; never displayed).
function ts(v) { return Date.parse(`${v.date}T${v.time || '12:00'}:00`); }

function valueLabel(v, type) {
  if (type === 'bp') return `${v.systolic}/${v.diastolic}`;
  return String(v.value);
}

// Inline SVG line chart. readings: ascending by date. Returns SVG string ('' if < 2 points).
// Dots carry data-i/data-s so taps can surface the value (no hover on touch).
export function renderChart(readings, type) {
  if (readings.length < 2) return '';
  const W = 320; const H = 150; const PAD = { l: 34, r: 10, t: 12, b: 22 };
  const xs = readings.map(ts);
  const xMin = Math.min(...xs); const xMax = Math.max(...xs);
  const series = type === 'bp'
    ? [{ key: 'systolic', cls: 'chart-line-a', name: 'Systolic' }, { key: 'diastolic', cls: 'chart-line-b', name: 'Diastolic' }]
    : [{ key: 'value', cls: 'chart-line-a', name: VITAL_TYPES[type].label }];
  const allVals = readings.flatMap((r) => series.map((s) => r[s.key]));
  let yMin = Math.min(...allVals); let yMax = Math.max(...allVals);
  const padY = Math.max((yMax - yMin) * 0.15, 1);
  yMin -= padY; yMax += padY;
  const x = (t) => PAD.l + ((t - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r);
  const y = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  const lines = series.map((s, si) => {
    const pts = readings.map((r) => `${x(ts(r)).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join(' ');
    const dots = readings.map((r, i) => `
      <circle class="chart-dot ${s.cls}" data-i="${i}" data-s="${si}"
        cx="${x(ts(r)).toFixed(1)}" cy="${y(r[s.key]).toFixed(1)}" r="4">
        <title>${esc(s.name)} ${esc(String(r[s.key]))} ${VITAL_TYPES[type].unit} — ${fmtDate(r.date)}${r.time ? ` ${esc(r.time)}` : ''}</title>
      </circle>`).join('');
    return `<polyline class="${s.cls}" fill="none" points="${pts}"/>${dots}`;
  }).join('');

  const first = readings[0]; const last = readings[readings.length - 1];
  return `
    <svg class="vital-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${VITAL_TYPES[type].label} over time">
      <line class="chart-axis" x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>
      <text class="chart-lbl" x="${PAD.l - 4}" y="${y(yMax - padY) + 4}" text-anchor="end">${Math.round(yMax - padY)}</text>
      <text class="chart-lbl" x="${PAD.l - 4}" y="${y(yMin + padY) + 4}" text-anchor="end">${Math.round(yMin + padY)}</text>
      <text class="chart-lbl" x="${PAD.l}" y="${H - 6}">${fmtDate(first.date)}</text>
      <text class="chart-lbl" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${fmtDate(last.date)}</text>
      ${lines}
    </svg>
    <p class="chart-caption" id="chart-caption">Tap a point to see its value.</p>
    ${type === 'bp' ? '<p class="chart-legend"><span class="legend-a">&#9632;</span> Systolic &nbsp;&nbsp; <span class="legend-b">&#9632;</span> Diastolic</p>' : ''}`;
}

function valueFields(type, t, editing) {
  const ev = (k) => esc(editing?.[k] ?? '');
  if (type === 'bp') {
    return `
      <div class="vital-pair">
        <label class="field"><span class="field-label">Systolic</span><input type="number" name="systolic" required min="30" max="300" inputmode="numeric" value="${ev('systolic')}"></label>
        <label class="field"><span class="field-label">Diastolic</span><input type="number" name="diastolic" required min="20" max="200" inputmode="numeric" value="${ev('diastolic')}"></label>
      </div>`;
  }
  let extra = '';
  if (type === 'sugar') {
    const ctx = editing?.context || '';
    extra = `<label class="field"><span class="field-label">When</span><select name="context">
      ${['', 'fasting', 'post-meal', 'random'].map((c) =>
    `<option value="${c}"${ctx === c ? ' selected' : ''}>${c || '-'}</option>`).join('')}
    </select></label>`;
  }
  return `<label class="field"><span class="field-label">${t.label} (${t.unit})</span>
    <input type="number" name="value" required step="0.1" min="0" inputmode="decimal" value="${ev('value')}"></label>${extra}`;
}

async function latestOf(memberId, type) {
  const readings = await getVitalsFor(memberId, type);
  return readings.length ? readings[readings.length - 1] : null;
}

// BMI from the latest weight (kg) and height (cm); null when either is missing.
async function bmiFor(memberId) {
  const [w, h] = await Promise.all([latestOf(memberId, 'weight'), latestOf(memberId, 'height')]);
  if (!w || !h || !h.value) return null;
  const bmi = w.value / ((h.value / 100) ** 2);
  return { bmi: Math.round(bmi * 10) / 10, w, h };
}

export async function vitalsView(app, memberId, type = 'weight', editingId = null) {
  const member = await get('members', memberId);
  if (!member) { location.hash = '#/'; return; }
  document.getElementById('topbar-title').textContent = `Vitals — ${member.name}`;
  document.getElementById('btn-back').hidden = false;
  document.getElementById('btn-home').hidden = false;
  document.title = `Vitals — ${member.name} · Family Health Tracker`;
  const t = VITAL_TYPES[type];
  const readings = await getVitalsFor(memberId, type);
  const newestFirst = [...readings].reverse();
  const editing = editingId ? readings.find((r) => r.id === editingId) : null;
  const bmiInfo = type === 'weight' ? await bmiFor(memberId) : null;

  const tabs = Object.entries(VITAL_TYPES).map(([key, v]) =>
    `<a class="chip${type === key ? ' chip-on' : ''}" href="#/member/${esc(memberId)}/vitals/${key}">${v.label}</a>`).join('');

  const rows = newestFirst.map((v) => `
    <li class="vital-row${editing && editing.id === v.id ? ' vaccine-row-editing' : ''}" data-id="${esc(v.id)}">
      <button type="button" class="vital-value vital-edit-btn" aria-label="Edit this reading">${esc(valueLabel(v, type))} <small>${t.unit}</small>
        ${v.context ? `<span class="badge badge-ongoing">${esc(v.context)}</span>` : ''}</button>
      <span class="vital-date">${fmtDate(v.date)}${v.time ? ` · ${esc(v.time)}` : ''}</span>
      <button type="button" class="vital-del" aria-label="Delete reading">&#10005;</button>
    </li>`).join('');

  app.innerHTML = `
    <section class="vitals">
      <div class="chips">${tabs}</div>
      ${renderChart(readings, type)}
      ${bmiInfo ? `<p class="chart-caption bmi-caption">BMI ${bmiInfo.bmi} (weight ${fmtDate(bmiInfo.w.date)} · height ${fmtDate(bmiInfo.h.date)})</p>` : ''}
      <form class="form vital-form" id="vital-form">
        ${editing ? '<p class="section-heading">Edit reading</p>' : ''}
        <div class="vital-pair">
          <label class="field"><span class="field-label">Date</span><input type="date" name="date" required value="${esc(editing?.date || todayStr())}"></label>
          <label class="field"><span class="field-label">Time (optional)</span><input type="time" name="time" value="${esc(editing?.time || '')}"></label>
        </div>
        ${valueFields(type, t, editing)}
        <p class="error" id="vital-error" hidden></p>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add reading'}</button>
          ${editing ? '<button class="btn btn-ghost" type="button" id="vital-cancel">Cancel</button>' : ''}
        </div>
      </form>
      ${readings.length
        ? `<ul class="vital-list">${rows}</ul>`
        : `<div class="empty"><p>No ${t.label.toLowerCase()} readings yet — add the first one above.</p></div>`}
    </section>`;

  // Tap a chart dot → show its value in the caption (touch has no hover).
  const caption = app.querySelector('#chart-caption');
  app.querySelectorAll('.chart-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      const r = readings[Number(dot.dataset.i)];
      const seriesName = type === 'bp' ? (dot.dataset.s === '0' ? 'Systolic' : 'Diastolic') : t.label;
      const val = type === 'bp' ? (dot.dataset.s === '0' ? r.systolic : r.diastolic) : r.value;
      caption.textContent = `${seriesName} ${val} ${t.unit} — ${fmtDate(r.date)}${r.time ? ` ${r.time}` : ''}`;
    });
  });

  app.querySelector('#vital-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: editing?.id || uuid(),
      memberId,
      type,
      date: f.get('date'),
      time: f.get('time') || '',
      createdAt: editing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (type === 'bp') {
      obj.systolic = Number(f.get('systolic'));
      obj.diastolic = Number(f.get('diastolic'));
    } else {
      obj.value = Number(f.get('value'));
      if (type === 'sugar') obj.context = f.get('context') || '';
    }
    try {
      await put('vitals', obj);
    } catch (err) {
      const errEl = app.querySelector('#vital-error');
      errEl.textContent = "Couldn't save — your phone's storage may be full.";
      errEl.hidden = false;
      return;
    }
    vitalsView(app, memberId, type);
  });

  const cancelBtn = app.querySelector('#vital-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => vitalsView(app, memberId, type));

  app.querySelectorAll('.vital-edit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await vitalsView(app, memberId, type, btn.closest('.vital-row').dataset.id);
      app.querySelector('#vital-form')?.scrollIntoView({ block: 'start' });
    });
  });

  app.querySelectorAll('.vital-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this reading?')) return;
      await del('vitals', btn.closest('.vital-row').dataset.id);
      vitalsView(app, memberId, type);
    });
  });
}

// Latest reading per type (+ BMI when computable), for the doctor report.
export async function latestVitalsSummary(memberId) {
  const out = [];
  for (const [key, t] of Object.entries(VITAL_TYPES)) {
    const last = await latestOf(memberId, key);
    if (!last) continue;
    out.push(`${t.label} ${valueLabel(last, key)} ${t.unit} (${fmtDate(last.date)})`);
  }
  const bmiInfo = await bmiFor(memberId);
  if (bmiInfo) out.push(`BMI ${bmiInfo.bmi}`);
  return out;
}
