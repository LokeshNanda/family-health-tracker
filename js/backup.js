// backup.js — JSON export/import of all data.

import { getAll, importData } from './db.js';

const APP_ID = 'family-health-tracker';
const SCHEMA_VERSION = 1;
const LAST_BACKUP_KEY = 'fht-last-backup';

export async function exportBackup() {
  const [members, records] = await Promise.all([getAll('members'), getAll('records')]);
  const payload = {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    members,
    records,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date();
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  a.href = url;
  a.download = `fht-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch (e) { /* storage may be unavailable; nudge just won't update */ }
  return { members: members.length, records: records.length };
}

export function lastBackupInfo() {
  let iso = null;
  try {
    iso = localStorage.getItem(LAST_BACKUP_KEY);
  } catch (e) { /* ignore */ }
  if (!iso) return 'Last backup: never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'Last backup: today';
  if (days === 1) return 'Last backup: yesterday';
  return `Last backup: ${days} days ago`;
}

// Parse and validate a backup file. Throws with a user-readable message.
export async function parseBackupFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || data.app !== APP_ID) {
    throw new Error('That file is not a Family Health Tracker backup.');
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) {
    throw new Error('This backup was made by a newer version of the app.');
  }
  if (!Array.isArray(data.members) || !Array.isArray(data.records)) {
    throw new Error('This backup file is incomplete or damaged.');
  }
  for (const m of data.members) {
    if (!m || typeof m.id !== 'string' || typeof m.name !== 'string') {
      throw new Error('This backup contains an invalid family member entry.');
    }
  }
  for (const r of data.records) {
    if (!r || typeof r.id !== 'string' || typeof r.memberId !== 'string' || typeof r.type !== 'string') {
      throw new Error('This backup contains an invalid record entry.');
    }
  }
  return data;
}

// mode: 'merge' | 'replace'
export async function importBackup(data, mode) {
  return importData({ members: data.members, records: data.records,
    vitals: data.vitals || [], photos: [] }, mode);
}
