// db.js — promisified IndexedDB wrapper and all data access for Family Health Tracker.
// Data model: see plan — stores `members` and `records` (single store, `type` field).

const DB_NAME = 'fht';
const DB_VERSION = 1;

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

// Delete a member and all their records atomically.
export async function deleteMemberCascade(memberId) {
  const db = await openDB();
  const tx = db.transaction(['members', 'records'], 'readwrite');
  tx.objectStore('members').delete(memberId);
  const index = tx.objectStore('records').index('memberId');
  const cursorReq = index.openCursor(IDBKeyRange.only(memberId));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await txDone(tx);
}

// Import a backup atomically. mode: 'merge' | 'replace'
export async function importData(members, records, mode) {
  const db = await openDB();
  const tx = db.transaction(['members', 'records'], 'readwrite');
  const mStore = tx.objectStore('members');
  const rStore = tx.objectStore('records');
  if (mode === 'replace') {
    mStore.clear();
    rStore.clear();
  }
  for (const m of members) mStore.put(m);
  for (const r of records) rStore.put(r);
  await txDone(tx);
  return { members: members.length, records: records.length };
}
