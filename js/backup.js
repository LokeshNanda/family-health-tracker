// backup.js — JSON export/import of all data.

import { getAll, importData } from './db.js';

const APP_ID = 'family-health-tracker';
const SCHEMA_VERSION = 2;
const LAST_BACKUP_KEY = 'fht-last-backup';

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}

export async function exportBackup() {
  const [members, records, vitals, photoObjs] = await Promise.all([
    getAll('members'), getAll('records'), getAll('vitals'), getAll('photos'),
  ]);
  const photos = [];
  for (const p of photoObjs) {
    photos.push({
      id: p.id, recordId: p.recordId, createdAt: p.createdAt,
      mime: p.blob.type, data: await blobToBase64(p.blob),
    });
  }
  const payload = {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    members,
    records,
    vitals,
    photos,
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
  if (data.vitals !== undefined && !Array.isArray(data.vitals)) {
    throw new Error('This backup file is incomplete or damaged.');
  }
  if (data.photos !== undefined) {
    if (!Array.isArray(data.photos)) {
      throw new Error('This backup file is incomplete or damaged.');
    }
    for (const p of data.photos) {
      if (!p || typeof p.id !== 'string' || typeof p.recordId !== 'string' || typeof p.data !== 'string') {
        throw new Error('This backup contains an invalid photo entry.');
      }
    }
  }
  return data;
}

// mode: 'merge' | 'replace'
export async function importBackup(data, mode) {
  const photos = (data.photos || []).map((p) => ({
    id: p.id, recordId: p.recordId, createdAt: p.createdAt || '',
    blob: base64ToBlob(p.data, p.mime),
  }));
  return importData({ members: data.members, records: data.records,
    vitals: data.vitals || [], photos }, mode);
}
