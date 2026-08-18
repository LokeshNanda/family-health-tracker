// db.js — promisified IndexedDB wrapper and all data access for Family Health Tracker.
// Data model: see plan — stores `members` and `records` (single store, `type` field).

const DB_NAME = 'fht';
const DB_VERSION = 3;

let dbPromise = null;

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for iOS < 15.4
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('members')) {
        db.createObjectStore('members', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('memberId', 'memberId');
        store.createIndex('byMemberDate', ['memberId', 'date']);
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('recordId', 'recordId');
      }
      if (!db.objectStoreNames.contains('vitals')) {
        const store = db.createObjectStore('vitals', { keyPath: 'id' });
        store.createIndex('byMemberTypeDate', ['memberId', 'type', 'date']);
      }
      if (!db.objectStoreNames.contains('vaccines')) {
        const store = db.createObjectStore('vaccines', { keyPath: 'id' });
        store.createIndex('memberId', 'memberId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function put(storeName, obj) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(obj);
  await txDone(tx);
  return obj;
}

export async function get(storeName, id) {
  const db = await openDB();
  return promisify(db.transaction(storeName).objectStore(storeName).get(id));
}

export async function getAll(storeName) {
  const db = await openDB();
  return promisify(db.transaction(storeName).objectStore(storeName).getAll());
}

export async function del(storeName, id) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(id);
  await txDone(tx);
}

// ---- Domain queries ----

export async function getMembers() {
  const members = await getAll('members');
  members.sort((a, b) => a.name.localeCompare(b.name));
  return members;
}

// Records for one member, newest first (compound index returns date-ascending).
export async function getRecordsForMember(memberId) {
  const db = await openDB();
  const index = db.transaction('records').objectStore('records').index('byMemberDate');
  const range = IDBKeyRange.bound([memberId, ''], [memberId, '￿']);
  const records = await promisify(index.getAll(range));
  records.reverse();
  // Same-date ties: newest createdAt first
  records.sort((a, b) => (a.date === b.date ? (b.createdAt || '').localeCompare(a.createdAt || '') : 0));
  return records;
}

export async function countRecordsForMember(memberId) {
  const db = await openDB();
  const index = db.transaction('records').objectStore('records').index('memberId');
  return promisify(index.count(memberId));
}

// Vitals for one member+type, oldest first (charts read left to right).
export async function getVitalsFor(memberId, type) {
  const db = await openDB();
  const index = db.transaction('vitals').objectStore('vitals').index('byMemberTypeDate');
  const range = IDBKeyRange.bound([memberId, type, ''], [memberId, type, '￿']);
  const vitals = await promisify(index.getAll(range));
  vitals.sort((a, b) => (a.date === b.date
    ? ((a.time || '') + a.createdAt).localeCompare((b.time || '') + b.createdAt)
    : 0));
  return vitals;
}

function deletePhotosByRecordId(tx, recordId) {
  const index = tx.objectStore('photos').index('recordId');
  const cursorReq = index.openCursor(IDBKeyRange.only(recordId));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
}

// Delete a record and its photos atomically.
export async function deleteRecordCascade(recordId) {
  const db = await openDB();
  const tx = db.transaction(['records', 'photos'], 'readwrite');
  tx.objectStore('records').delete(recordId);
  deletePhotosByRecordId(tx, recordId);
  await txDone(tx);
}

// Delete a member with all their records, those records' photos, vitals, and vaccines.
export async function deleteMemberCascade(memberId) {
  const db = await openDB();
  const tx = db.transaction(['members', 'records', 'photos', 'vitals', 'vaccines'], 'readwrite');
  tx.objectStore('members').delete(memberId);
  const recIndex = tx.objectStore('records').index('memberId');
  const recCursor = recIndex.openCursor(IDBKeyRange.only(memberId));
  recCursor.onsuccess = () => {
    const cursor = recCursor.result;
    if (cursor) {
      deletePhotosByRecordId(tx, cursor.value.id);
      cursor.delete();
      cursor.continue();
    }
  };
  const vitIndex = tx.objectStore('vitals').index('byMemberTypeDate');
  const vitCursor = vitIndex.openCursor(IDBKeyRange.bound([memberId, '', ''], [memberId, '￿', '￿']));
  vitCursor.onsuccess = () => {
    const cursor = vitCursor.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
  const vacIndex = tx.objectStore('vaccines').index('memberId');
  const vacCursor = vacIndex.openCursor(IDBKeyRange.only(memberId));
  vacCursor.onsuccess = () => {
    const cursor = vacCursor.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
  await txDone(tx);
}

export async function getVaccinesFor(memberId) {
  const db = await openDB();
  const index = db.transaction('vaccines').objectStore('vaccines').index('memberId');
  return promisify(index.getAll(IDBKeyRange.only(memberId)));
}

// Import a backup atomically. mode: 'merge' | 'replace'
export async function importData({ members, records, vitals = [], photos = [], vaccines = [] }, mode) {
  const db = await openDB();
  const tx = db.transaction(['members', 'records', 'vitals', 'photos', 'vaccines'], 'readwrite');
  const stores = {
    members: tx.objectStore('members'), records: tx.objectStore('records'),
    vitals: tx.objectStore('vitals'), photos: tx.objectStore('photos'),
    vaccines: tx.objectStore('vaccines'),
  };
  if (mode === 'replace') Object.values(stores).forEach((s) => s.clear());
  for (const m of members) stores.members.put(m);
  for (const r of records) stores.records.put(r);
  for (const v of vitals) stores.vitals.put(v);
  for (const p of photos) stores.photos.put(p);
  for (const vc of vaccines) stores.vaccines.put(vc);
  await txDone(tx);
  return { members: members.length, records: records.length, vitals: vitals.length, photos: photos.length, vaccines: vaccines.length };
}
