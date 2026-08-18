// backup.js — JSON export/import of all data.

import { getAll, importData } from './db.js';
import { todayStr } from './fmt.js';

const APP_ID = 'family-health-tracker';
const SCHEMA_VERSION = 3;
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

async function buildBackupPayload() {
  const [members, records, vitals, photoObjs, vaccines] = await Promise.all([
    getAll('members'), getAll('records'), getAll('vitals'), getAll('photos'), getAll('vaccines'),
  ]);
  const photos = [];
  for (const p of photoObjs) {
    photos.push({
      id: p.id, recordId: p.recordId, createdAt: p.createdAt,
      mime: p.blob.type, data: await blobToBase64(p.blob),
    });
  }
  return {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    members,
    records,
    vitals,
    photos,
    vaccines,
  };
}

function backupFilename() {
  return `fht-backup-${todayStr()}.json`;
}

function markBackupDone() {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch (e) { /* storage may be unavailable; nudge just won't update */ }
}

export async function exportBackup() {
  const payload = await buildBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  markBackupDone();
  return { members: payload.members.length, records: payload.records.length };
}

// True when the browser can hand a text file to the native share sheet.
// The share uses .txt/text/plain: browsers enforce an allowlist of shareable
// file types and .json is not on it (share() rejects even when canShare passes).
export function canShareBackup() {
  if (!navigator.canShare || !navigator.share) return false;
  try {
    return navigator.canShare({ files: [new File(['x'], 'probe.txt', { type: 'text/plain' })] });
  } catch (e) {
    return false;
  }
}

// Opens the native share sheet (Google Drive, WhatsApp, email, ...).
// Rejects with AbortError if the user closes the sheet — callers ignore that.
export async function shareBackup() {
  const payload = await buildBackupPayload();
  const file = new File(
    [JSON.stringify(payload, null, 2)],
    backupFilename().replace(/\.json$/, '.txt'),
    { type: 'text/plain' },
  );
  await navigator.share({ files: [file], title: 'Family Health Tracker backup' });
  markBackupDone();
  return { members: payload.members.length, records: payload.records.length };
}

export function lastBackupInfo() {
  let iso = null;
  try {
    iso = localStorage.getItem(LAST_BACKUP_KEY);
  } catch (e) { /* ignore */ }
  if (!iso) return 'Last backup: never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (Number.isNaN(days)) return 'Last backup: never';
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
  if (data.vaccines !== undefined) {
    if (!Array.isArray(data.vaccines)) {
      throw new Error('This backup file is incomplete or damaged.');
    }
    for (const vc of data.vaccines) {
      if (!vc || typeof vc.id !== 'string' || typeof vc.memberId !== 'string' || typeof vc.name !== 'string') {
        throw new Error('This backup contains an invalid vaccine entry.');
      }
    }
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
  // Normalize dates to strings: a record/vital with a missing or non-string
  // date would otherwise drop out of the compound indexes and become
  // invisible on the timeline and report while still counted elsewhere.
  const records = data.records.map((r) => (typeof r.date === 'string' ? r : { ...r, date: '' }));
  const vitals = (data.vitals || []).map((v) => (typeof v.date === 'string' ? v : { ...v, date: '' }));
  return importData({ members: data.members, records,
    vitals, photos, vaccines: data.vaccines || [] }, mode);
}
