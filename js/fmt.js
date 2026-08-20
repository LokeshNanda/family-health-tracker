// fmt.js — shared vocabulary: escaping, date formatting, record-type metadata.

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format "YYYY-MM-DD" by splitting — never new Date(str), which shifts a day
// in some timezones. Non-conforming input (possible via imported backups) is
// returned HTML-escaped so it can never render as markup.
export function fmtDate(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return esc(ymd || '');
  const [y, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// Today as "YYYY-MM-DD" in local time.
export function todayStr() {
  const t = new Date();
  return [t.getFullYear(), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0')].join('-');
}

export const ICONS = {
  symptom: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4a2 2 0 1 0-4 0v9.3a4.5 4.5 0 1 0 4 0V4z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="11" cy="17.5" r="2" fill="currentColor"/></svg>',
  visit: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6.5" width="17" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 6V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10v6M9 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  medication: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="9" width="18" height="7" rx="3.5" transform="rotate(-35 12 12.5)" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="9.2" y1="14.6" x2="14.8" y2="10.4" stroke="currentColor" stroke-width="1.8"/></svg>',
  lab: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3.5h4M10.8 3.5v5.2L5.6 17.6A2 2 0 0 0 7.3 20.5h9.4a2 2 0 0 0 1.7-2.9L13.2 8.7V3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 13.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

export const TYPES = {
  symptom: { label: 'Symptom', plural: 'Symptoms', cls: 'symptom' },
  visit: { label: 'Doctor visit', plural: 'Visits', cls: 'visit' },
  medication: { label: 'Medication', plural: 'Medications', cls: 'medication' },
  lab: { label: 'Lab report', plural: 'Lab reports', cls: 'lab' },
};
