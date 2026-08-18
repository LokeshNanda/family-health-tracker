# Photo Attachments & Vitals Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-device photo attachments (prescriptions/lab reports) to records and per-member vitals tracking (weight, BP, sugar, temperature) with SVG charts, including backup format v2.

**Architecture:** IndexedDB bumps v1→v2 adding `photos` (compressed JPEG blobs, referenced from `record.attachments`) and `vitals` (numeric time series with compound `[memberId, type, date]` index) stores. Two new ES modules (`js/photos.js`, `js/vitals.js`) keep `views.js` focused; existing views/backup/router get small hooks. No dependencies, no build step.

**Tech Stack:** Vanilla JS (ES modules), IndexedDB, inline SVG charts, canvas-based image compression. Verification via Playwright-core driving headless Edge (test scripts live outside the repo).

**Spec:** `docs/superpowers/specs/2026-08-18-photos-vitals-design.md`

## Global Constraints

- No npm dependencies in the repo; no build step; all asset paths `./`-relative.
- Dates stored as `"YYYY-MM-DD"` strings; NEVER `new Date("YYYY-MM-DD")` for display (UTC shift bug) — format by splitting.
- Every rendered user string goes through `esc()` from `views.js` (photos/vitals modules must import or replicate it).
- All IDs via `uuid()` from `db.js`.
- `sw.js` CACHE string must be bumped and new files added to ASSETS in the final task, or deployed phones keep v1.
- Test harness: a scratch dir outside the repo with `npm i playwright-core`; headless Edge via `chromium.launch({ channel: 'msedge', headless: true })`; static server pattern from the harness snippet in Task 1.

---

### Task 1: db.js v2 — new stores, cascades, vitals queries

**Files:**
- Modify: `js/db.js`
- Test: `<scratch>/t1-db.js` (harness below)

**Interfaces:**
- Produces: `DB_VERSION = 2`; stores `photos` (keyPath `id`, index `recordId`) and `vitals` (keyPath `id`, index `byMemberTypeDate` on `[memberId, type, date]`).
- Produces: `getVitalsFor(memberId, type): Promise<Vital[]>` — ascending by date (then createdAt).
- Produces: `deleteRecordCascade(recordId): Promise<void>` — deletes record + its photos in one tx.
- Produces: `deleteMemberCascade(memberId)` — now also deletes the member's vitals and the photos of each of their records (one tx over all four stores).
- Produces: `importData(data, mode)` — signature changes to accept `{members, records, vitals, photos}` object.

- [ ] **Step 1: Apply the db.js changes**

In `js/db.js`, change `DB_VERSION` to `2` and extend `onupgradeneeded` (runs for both fresh installs and v1→v2 upgrades since store-existence is checked):

```js
const DB_VERSION = 2;
// inside req.onupgradeneeded, after the existing two store blocks:
if (!db.objectStoreNames.contains('photos')) {
  const store = db.createObjectStore('photos', { keyPath: 'id' });
  store.createIndex('recordId', 'recordId');
}
if (!db.objectStoreNames.contains('vitals')) {
  const store = db.createObjectStore('vitals', { keyPath: 'id' });
  store.createIndex('byMemberTypeDate', ['memberId', 'type', 'date']);
}
```

Add domain functions (below `countRecordsForMember`):

```js
// Vitals for one member+type, oldest first (charts read left→right).
export async function getVitalsFor(memberId, type) {
  const db = await openDB();
  const index = db.transaction('vitals').objectStore('vitals').index('byMemberTypeDate');
  const range = IDBKeyRange.bound([memberId, type, ''], [memberId, type, '\uffff']);
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
```

Replace `deleteMemberCascade` with a four-store cascade:

```js
export async function deleteMemberCascade(memberId) {
  const db = await openDB();
  const tx = db.transaction(['members', 'records', 'photos', 'vitals'], 'readwrite');
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
  const vitCursor = vitIndex.openCursor(IDBKeyRange.bound([memberId, '', ''], [memberId, '\uffff', '\uffff']));
  vitCursor.onsuccess = () => {
    const cursor = vitCursor.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
  await txDone(tx);
}
```

Replace `importData(members, records, mode)` with:

```js
export async function importData({ members, records, vitals = [], photos = [] }, mode) {
  const db = await openDB();
  const tx = db.transaction(['members', 'records', 'vitals', 'photos'], 'readwrite');
  const stores = {
    members: tx.objectStore('members'), records: tx.objectStore('records'),
    vitals: tx.objectStore('vitals'), photos: tx.objectStore('photos'),
  };
  if (mode === 'replace') Object.values(stores).forEach((s) => s.clear());
  for (const m of members) stores.members.put(m);
  for (const r of records) stores.records.put(r);
  for (const v of vitals) stores.vitals.put(v);
  for (const p of photos) stores.photos.put(p);
  await txDone(tx);
  return { members: members.length, records: records.length, vitals: vitals.length, photos: photos.length };
}
```

Update the call site in `js/backup.js` `importBackup` to pass the object form (full backup rework happens in Task 4; for now just keep it compiling):

```js
export async function importBackup(data, mode) {
  return importData({ members: data.members, records: data.records,
    vitals: data.vitals || [], photos: [] }, mode);
}
```

Also update `js/views.js` record-delete handler to use the cascade (change `await del('records', record.id);` to `await deleteRecordCascade(record.id);` and add `deleteRecordCascade` to the db.js import list).

- [ ] **Step 2: Syntax-check all modules**

Run from the repo root (PowerShell): pipe each of `js/*.js` through `node --check --input-type=module -`. Expected: all OK.

- [ ] **Step 3: Browser test — upgrade + cascades**

Save as `<scratch>/t1-db.js` (server harness reused by all tasks):

```js
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'C:/Users/lokeshn/dev/Personal/family-health-tracker';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve(port) {
  const server = http.createServer((req, res) => {
    let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
    fs.readFile(path.join(ROOT, p), (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d);
    });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
(async () => {
  const server = await serve(8130);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:8130/');
  await page.waitForSelector('text=Add family member');
  const result = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fht'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const stores = [...db.objectStoreNames].sort();
    const version = db.version;
    db.close();
    return { stores, version };
  });
  console.log('version:', result.version, 'stores:', result.stores.join(','));
  if (result.version !== 2 || result.stores.join(',') !== 'members,photos,records,vitals') {
    console.error('FAIL: expected v2 with 4 stores'); process.exit(1);
  }
  console.log('T1 PASS');
  await browser.close(); server.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
```

Run: `node t1-db.js` from the scratch dir. Expected: `T1 PASS`.

- [ ] **Step 4: Commit**

```bash
git add js/db.js js/backup.js js/views.js
git commit -m "feat: IndexedDB v2 with photos and vitals stores, cascading deletes"
```

---

### Task 2: photos.js + record-form photo picker, timeline badge, viewer

**Files:**
- Create: `js/photos.js`
- Modify: `js/views.js` (recordFormView, recordCard), `css/style.css`
- Test: `<scratch>/t2-photos.js`

**Interfaces:**
- Consumes: `put`, `get`, `del`, `uuid`, `openDB` from `db.js`; `esc` from `views.js`.
- Produces: `compressImage(file): Promise<Blob>`; `getPhotosForRecord(recordId): Promise<Photo[]>`; `photoPicker(containerEl, existingRecordId): Promise<{ commit(recordId): Promise<string[]> }>`; `openViewer(blob): void`.

- [ ] **Step 1: Write js/photos.js**

```js
// photos.js — on-device photo attachments: compression, storage, picker UI, viewer.

import { uuid, put, del, openDB } from './db.js';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

// Downscale to MAX_EDGE on the long side, re-encode as JPEG.
export async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not encode image');
  return blob;
}

export async function getPhotosForRecord(recordId) {
  const db = await openDB();
  const index = db.transaction('photos').objectStore('photos').index('recordId');
  return new Promise((resolve, reject) => {
    const req = index.getAll(IDBKeyRange.only(recordId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Full-screen photo viewer overlay.
export function openViewer(blob) {
  const url = URL.createObjectURL(blob);
  const overlay = document.createElement('div');
  overlay.className = 'photo-viewer';
  overlay.innerHTML = `<img src="${url}" alt="Attached photo"><button class="photo-viewer-close" aria-label="Close">&#10005;</button>`;
  const close = () => { URL.revokeObjectURL(url); overlay.remove(); };
  overlay.addEventListener('click', close);
  document.body.appendChild(overlay);
}

// Renders thumbnails + "Add photo" into containerEl. Tracks pending adds and removals.
// commit(recordId) persists changes and returns the final photo-id array.
export async function photoPicker(containerEl, existingRecordId) {
  const existing = existingRecordId ? await getPhotosForRecord(existingRecordId) : [];
  const kept = new Map(existing.map((p) => [p.id, p]));   // existing photos still attached
  const added = [];                                        // { tempUrl, blob }
  const objectUrls = [];

  containerEl.innerHTML = `
    <div class="photo-thumbs"></div>
    <label class="btn btn-ghost btn-sm photo-add-btn">&#128247; Add photo
      <input type="file" accept="image/*" capture="environment" multiple hidden>
    </label>
    <p class="error photo-error" hidden></p>`;
  const thumbs = containerEl.querySelector('.photo-thumbs');
  const fileInput = containerEl.querySelector('input[type="file"]');
  const errEl = containerEl.querySelector('.photo-error');

  function renderThumb(blob, key, isExisting) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    wrap.innerHTML = `<img src="${url}" alt="Attachment"><button type="button" class="photo-remove" aria-label="Remove photo">&#10005;</button>`;
    wrap.querySelector('img').addEventListener('click', () => openViewer(blob));
    wrap.querySelector('.photo-remove').addEventListener('click', () => {
      if (isExisting) kept.delete(key);
      else added.splice(added.findIndex((a) => a.key === key), 1);
      wrap.remove();
    });
    thumbs.appendChild(wrap);
  }

  for (const p of existing) renderThumb(p.blob, p.id, true);

  fileInput.addEventListener('change', async () => {
    errEl.hidden = true;
    for (const file of fileInput.files) {
      try {
        const blob = await compressImage(file);
        const entry = { key: uuid(), blob };
        added.push(entry);
        renderThumb(blob, entry.key, false);
      } catch (e) {
        errEl.textContent = "Couldn't read that image.";
        errEl.hidden = false;
      }
    }
    fileInput.value = '';
  });

  return {
    async commit(recordId) {
      for (const p of existing) {
        if (!kept.has(p.id)) await del('photos', p.id);
      }
      const ids = [...kept.keys()];
      for (const a of added) {
        const photo = { id: uuid(), recordId, blob: a.blob, createdAt: new Date().toISOString() };
        await put('photos', photo);
        ids.push(photo.id);
      }
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
      return ids;
    },
  };
}
```

- [ ] **Step 2: Wire into views.js**

In `recordFormView`: import `photoPicker` from `./photos.js`. After the notes field in the form HTML, add:

```html
${field('Photos (prescriptions, reports)', '<div id="photo-picker"></div>')}
```

But `field()` wraps in a `<label>` (label+file input conflict) — instead insert a plain block before the error paragraph:

```html
<div class="field"><span class="field-label">Photos (prescriptions, reports)</span><div id="photo-picker"></div></div>
```

After `app.innerHTML = ...`, initialize: `const picker = await photoPicker(app.querySelector('#photo-picker'), record?.id || null);`

In the submit handler, after building `obj` and BEFORE `await put('records', obj)`:

```js
obj.attachments = await picker.commit(obj.id);
```

(Photos are written first; if the record put then failed the photos would be orphaned, but put failures here are effectively quota errors that would have failed the photo writes too — acceptable for v2.)

In `recordCard`, add a photo badge to `.record-top` after the type label:

```js
${(r.attachments && r.attachments.length) ? `<span class="badge badge-photos">&#128206; ${r.attachments.length}</span>` : ''}
```

Place it inside the `record-type` span's parent div (append as a third element of `.record-top`).

- [ ] **Step 3: Add CSS**

Append to `css/style.css` before the `@media print` block:

```css
/* ---- Photo attachments ---- */
.photo-thumbs { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
.photo-thumb { position: relative; }
.photo-thumb img {
  width: 72px; height: 72px; object-fit: cover;
  border-radius: 10px; border: 1px solid var(--line); cursor: pointer;
}
.photo-remove {
  position: absolute; top: -6px; right: -6px;
  width: 22px; height: 22px; border-radius: 50%;
  border: none; background: var(--danger); color: #fff;
  font-size: 0.7rem; cursor: pointer; line-height: 1;
}
.photo-add-btn input { display: none; }
.badge-photos { background: var(--paper); color: var(--ink-soft); }
.photo-viewer {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(20, 30, 26, 0.92);
  display: flex; align-items: center; justify-content: center;
}
.photo-viewer img { max-width: 96vw; max-height: 92vh; border-radius: 8px; }
.photo-viewer-close {
  position: absolute; top: calc(0.75rem + env(safe-area-inset-top)); right: 0.75rem;
  width: 44px; height: 44px; border-radius: 50%; border: none;
  background: rgba(255,255,255,0.15); color: #fff; font-size: 1.1rem; cursor: pointer;
}
```

- [ ] **Step 4: Syntax-check, then browser test**

Syntax-check all `js/*.js` as in Task 1 Step 2.

Save as `<scratch>/t2-photos.js` (reuse the `serve()` harness from Task 1; port 8131). Test body after `page.goto`:

```js
// seed: member + open symptom form
await page.click('text=+ Add family member');
await page.fill('input[name="name"]', 'Photo Tester');
await page.click('button[type="submit"]');
await page.click('a:has-text("Symptom")');
await page.fill('input[name="title"]', 'Rash');
// attach a generated PNG via the hidden file input
await page.setInputFiles('input[type="file"][accept="image/*"]', {
  name: 'rx.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
});
await page.waitForSelector('.photo-thumb img');
await page.click('button[type="submit"]');
await page.waitForSelector('text=Rash');
// badge on timeline
const badge = await page.locator('.badge-photos').textContent();
console.log('badge:', badge.trim());
// photo persisted in IDB
const photoCount = await page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('fht'); r.onsuccess = () => res(r.result); });
  const n = await new Promise((res) => {
    const req = db.transaction('photos').objectStore('photos').count();
    req.onsuccess = () => res(req.result);
  });
  db.close(); return n;
});
console.log('photos in IDB:', photoCount);
// delete record → cascade
await page.click('.record-body');
await page.waitForSelector('#btn-del-record');
page.on('dialog', (d) => d.accept());
await page.click('#btn-del-record');
await page.waitForSelector('text=No records yet');
const after = await page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('fht'); r.onsuccess = () => res(r.result); });
  const n = await new Promise((res) => {
    const req = db.transaction('photos').objectStore('photos').count();
    req.onsuccess = () => res(req.result);
  });
  db.close(); return n;
});
console.log('photos after record delete:', after);
if (photoCount !== 1 || after !== 0) { console.error('T2 FAIL'); process.exit(1); }
console.log('T2 PASS');
```

Run: `node t2-photos.js`. Expected: `T2 PASS`.

- [ ] **Step 5: Commit**

```bash
git add js/photos.js js/views.js css/style.css
git commit -m "feat: photo attachments on records with compression, thumbnails, viewer"
```

---

### Task 3: vitals.js — vitals screen with SVG charts

**Files:**
- Create: `js/vitals.js`
- Modify: `js/app.js` (route), `js/views.js` (Vitals button on member screen), `css/style.css`
- Test: `<scratch>/t3-vitals.js`

**Interfaces:**
- Consumes: `uuid`, `put`, `del`, `get`, `getVitalsFor` from `db.js`; `esc`, `fmtDate` from `views.js` — import `{ esc, fmtDate }` (both are exported).
- Produces: `vitalsView(app, memberId, type?)` — registered under route `#/member/:id/vitals` and `#/member/:id/vitals/:type`.

**Before writing the chart code, the implementer should invoke the `dataviz` skill** (it triggers on any chart creation) and apply its guidance within the app's existing palette tokens.

- [ ] **Step 1: Write js/vitals.js**

```js
// vitals.js — per-member vitals: tabs, SVG line chart, add form, reading list.

import { uuid, put, del, get, getVitalsFor } from './db.js';
import { esc, fmtDate } from './views.js';

export const VITAL_TYPES = {
  weight: { label: 'Weight', unit: 'kg', fields: 'single' },
  bp:     { label: 'BP', unit: 'mmHg', fields: 'double' },
  sugar:  { label: 'Sugar', unit: 'mg/dL', fields: 'single+context' },
  temp:   { label: 'Temp', unit: '\u00b0F', fields: 'single' },
};

function todayStr() {
  const t = new Date();
  return [t.getFullYear(), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0')].join('-');
}

// Timestamp for x-positioning only (relative spacing; not displayed).
function ts(v) { return Date.parse(`${v.date}T${v.time || '12:00'}:00`); }

function valueLabel(v, type) {
  if (type === 'bp') return `${v.systolic}/${v.diastolic}`;
  return String(v.value);
}

// Inline SVG line chart. readings: ascending by date. Returns SVG string.
export function renderChart(readings, type) {
  if (readings.length < 2) return '';
  const W = 320, H = 150, PAD = { l: 34, r: 10, t: 12, b: 22 };
  const xs = readings.map(ts);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const series = type === 'bp'
    ? [{ key: 'systolic', cls: 'chart-line-a' }, { key: 'diastolic', cls: 'chart-line-b' }]
    : [{ key: 'value', cls: 'chart-line-a' }];
  const allVals = readings.flatMap((r) => series.map((s) => r[s.key]));
  let yMin = Math.min(...allVals), yMax = Math.max(...allVals);
  const padY = Math.max((yMax - yMin) * 0.15, 1);
  yMin -= padY; yMax += padY;
  const x = (t) => PAD.l + ((t - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r);
  const y = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  const lines = series.map((s) => {
    const pts = readings.map((r) => `${x(ts(r)).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join(' ');
    const dots = readings.map((r) =>
      `<circle class="chart-dot ${s.cls}" cx="${x(ts(r)).toFixed(1)}" cy="${y(r[s.key]).toFixed(1)}" r="3"/>`).join('');
    return `<polyline class="${s.cls}" fill="none" points="${pts}"/>${dots}`;
  }).join('');

  const first = readings[0], last = readings[readings.length - 1];
  return `
    <svg class="vital-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${VITAL_TYPES[type].label} chart">
      <line class="chart-axis" x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>
      <text class="chart-lbl" x="${PAD.l - 4}" y="${y(yMax - padY) + 4}" text-anchor="end">${Math.round(yMax - padY)}</text>
      <text class="chart-lbl" x="${PAD.l - 4}" y="${y(yMin + padY) + 4}" text-anchor="end">${Math.round(yMin + padY)}</text>
      <text class="chart-lbl" x="${PAD.l}" y="${H - 6}">${fmtDate(first.date)}</text>
      <text class="chart-lbl" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${fmtDate(last.date)}</text>
      ${lines}
    </svg>
    ${type === 'bp' ? '<p class="chart-legend"><span class="legend-a">&#9632;</span> Systolic &nbsp; <span class="legend-b">&#9632;</span> Diastolic</p>' : ''}`;
}

function valueFields(type, t) {
  if (type === 'bp') {
    return `
      <div class="vital-pair">
        <label class="field"><span class="field-label">Systolic</span><input type="number" name="systolic" required min="30" max="300" inputmode="numeric"></label>
        <label class="field"><span class="field-label">Diastolic</span><input type="number" name="diastolic" required min="20" max="200" inputmode="numeric"></label>
      </div>`;
  }
  let extra = '';
  if (type === 'sugar') {
    extra = `<label class="field"><span class="field-label">When</span><select name="context">
      <option value="">-</option><option value="fasting">Fasting</option>
      <option value="post-meal">Post-meal</option><option value="random">Random</option>
    </select></label>`;
  }
  return `<label class="field"><span class="field-label">${t.label} (${t.unit})</span>
    <input type="number" name="value" required step="0.1" min="0" inputmode="decimal"></label>${extra}`;
}

export async function vitalsView(app, memberId, type = 'weight') {
  const member = await get('members', memberId);
  if (!member) { location.hash = '#/'; return; }
  document.getElementById('topbar-title').textContent = `Vitals \u2014 ${member.name}`;
  document.getElementById('btn-back').hidden = false;
  const t = VITAL_TYPES[type];
  const readings = await getVitalsFor(memberId, type);
  const newestFirst = [...readings].reverse();

  const tabs = Object.entries(VITAL_TYPES).map(([key, v]) =>
    `<a class="chip${type === key ? ' chip-on' : ''}" href="#/member/${esc(memberId)}/vitals/${key}">${v.label}</a>`).join('');

  const rows = newestFirst.map((v) => `
    <li class="vital-row" data-id="${esc(v.id)}">
      <span class="vital-value">${esc(valueLabel(v, type))} <small>${t.unit}</small>
        ${v.context ? `<span class="badge badge-ongoing">${esc(v.context)}</span>` : ''}</span>
      <span class="vital-date">${fmtDate(v.date)}${v.time ? ` \u00b7 ${esc(v.time)}` : ''}</span>
      <button class="vital-del" aria-label="Delete reading">&#10005;</button>
    </li>`).join('');

  app.innerHTML = `
    <section class="vitals">
      <div class="chips">${tabs}</div>
      ${renderChart(readings, type)}
      <form class="form vital-form" id="vital-form">
        <div class="vital-pair">
          <label class="field"><span class="field-label">Date</span><input type="date" name="date" required value="${todayStr()}"></label>
          <label class="field"><span class="field-label">Time (optional)</span><input type="time" name="time"></label>
        </div>
        ${valueFields(type, t)}
        <button class="btn btn-primary btn-block" type="submit">Add reading</button>
      </form>
      ${readings.length
        ? `<ul class="vital-list">${rows}</ul>`
        : `<div class="empty"><p>No ${t.label.toLowerCase()} readings yet.</p></div>`}
    </section>`;

  app.querySelector('#vital-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: uuid(), memberId, type,
      date: f.get('date'), time: f.get('time') || '',
      createdAt: new Date().toISOString(),
    };
    if (type === 'bp') {
      obj.systolic = Number(f.get('systolic'));
      obj.diastolic = Number(f.get('diastolic'));
    } else {
      obj.value = Number(f.get('value'));
      if (type === 'sugar') obj.context = f.get('context') || '';
    }
    await put('vitals', obj);
    vitalsView(app, memberId, type);
  });

  app.querySelectorAll('.vital-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this reading?')) return;
      await del('vitals', btn.closest('.vital-row').dataset.id);
      vitalsView(app, memberId, type);
    });
  });
}

// Latest reading per type, for the doctor report. Returns array of strings.
export async function latestVitalsSummary(memberId) {
  const out = [];
  for (const [key, t] of Object.entries(VITAL_TYPES)) {
    const readings = await getVitalsFor(memberId, key);
    if (!readings.length) continue;
    const last = readings[readings.length - 1];
    out.push(`${t.label} ${valueLabel(last, key)} ${t.unit} (${fmtDate(last.date)})`);
  }
  return out;
}
```

- [ ] **Step 2: Route + member-screen button**

`js/app.js`: import `vitalsView` from `./vitals.js`; add BEFORE the member catch-all route:

```js
[/^#\/member\/([^/]+)\/vitals(?:\/(weight|bp|sugar|temp))?$/,
  (id, type) => vitalsView(app, id, type || 'weight')],
```

Note: the optional group yields `undefined`, and `route()` maps params through `decodeURIComponent` — guard it there by changing the mapper to `match.slice(1).map((p) => (p === undefined ? p : decodeURIComponent(p)))`.

`js/views.js` `memberView`: in `.member-actions`, add after the Doctor report link:

```html
<a class="btn btn-ghost btn-sm" href="#/member/${esc(memberId)}/vitals">Vitals</a>
```

- [ ] **Step 3: CSS**

Append to `css/style.css` (before print block):

```css
/* ---- Vitals ---- */
.vital-chart { width: 100%; height: auto; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 0.75rem; }
.chart-axis { stroke: var(--line); stroke-width: 1; }
.chart-lbl { font-size: 9px; fill: var(--ink-soft); font-family: var(--font-body); }
.chart-line-a { stroke: var(--pine); stroke-width: 2; }
.chart-line-b { stroke: var(--blue); stroke-width: 2; }
circle.chart-line-a, .chart-dot.chart-line-a { fill: var(--pine); stroke: none; }
circle.chart-line-b, .chart-dot.chart-line-b { fill: var(--blue); stroke: none; }
.chart-legend { font-size: 0.8rem; color: var(--ink-soft); margin: -0.25rem 0 0.75rem; }
.legend-a { color: var(--pine); } .legend-b { color: var(--blue); }
.vital-form { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem; margin-bottom: 0.75rem; }
.vital-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
.vital-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.vital-row { display: flex; align-items: center; gap: 0.6rem; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.5rem 0.75rem; }
.vital-value { font-weight: 600; flex: 1; }
.vital-value small { color: var(--ink-soft); font-weight: 400; }
.vital-date { color: var(--ink-soft); font-size: 0.85rem; }
.vital-del { border: none; background: none; color: var(--danger); font-size: 0.9rem; cursor: pointer; min-width: 32px; min-height: 32px; }
```

- [ ] **Step 4: Syntax-check + browser test**

Syntax-check all modules. Save `<scratch>/t3-vitals.js` (harness, port 8132). Test body:

```js
await page.click('text=+ Add family member');
await page.fill('input[name="name"]', 'Vitals Tester');
await page.click('button[type="submit"]');
await page.click('a:has-text("Vitals")');
await page.waitForSelector('#vital-form');
// two weight readings → chart appears
await page.fill('input[name="date"]', '2026-08-10');
await page.fill('input[name="value"]', '14.2');
await page.click('text=Add reading');
await page.waitForSelector('.vital-row');
await page.fill('input[name="date"]', '2026-08-17');
await page.fill('input[name="value"]', '14.6');
await page.click('text=Add reading');
await page.waitForSelector('svg.vital-chart');
// BP tab → two-line chart
await page.click('a.chip:has-text("BP")');
await page.waitForSelector('input[name="systolic"]');
await page.fill('input[name="date"]', '2026-08-10');
await page.fill('input[name="systolic"]', '118');
await page.fill('input[name="diastolic"]', '76');
await page.click('text=Add reading');
await page.fill('input[name="date"]', '2026-08-17');
await page.fill('input[name="systolic"]', '122');
await page.fill('input[name="diastolic"]', '80');
await page.click('text=Add reading');
await page.waitForSelector('svg.vital-chart');
const lines = await page.locator('svg.vital-chart polyline').count();
console.log('bp polylines:', lines);
// delete a reading
page.on('dialog', (d) => d.accept());
const rowsBefore = await page.locator('.vital-row').count();
await page.locator('.vital-del').first().click();
await page.waitForFunction((n) => document.querySelectorAll('.vital-row').length === n - 1, rowsBefore);
if (lines !== 2) { console.error('T3 FAIL'); process.exit(1); }
console.log('T3 PASS');
```

Run: `node t3-vitals.js`. Expected: `T3 PASS`.

- [ ] **Step 5: Commit**

```bash
git add js/vitals.js js/app.js js/views.js css/style.css
git commit -m "feat: vitals tracking with SVG charts (weight, BP, sugar, temperature)"
```

---

### Task 4: Doctor report — Recent vitals section

**Files:**
- Modify: `js/views.js` (reportView)
- Test: `<scratch>/t4-report.js`

**Interfaces:**
- Consumes: `latestVitalsSummary(memberId)` from `vitals.js`.

- [ ] **Step 1: Extend reportView**

In `js/views.js`, import `latestVitalsSummary` from `./vitals.js`. In `reportView`, after computing `activeMeds`, add:

```js
const vitalLines = await latestVitalsSummary(memberId);
```

In the template, after the `</header>` and before the Current-medications section:

```html
${vitalLines.length ? `
  <h3 class="report-section">Recent vitals</h3>
  <p class="report-vitals">${vitalLines.map(esc).join(' \u00b7 ')}</p>` : ''}
```

Add CSS: `.report-vitals { margin: 0.3rem 0; }` (prints fine as plain text; no extra print rules needed).

**Import-cycle note:** `vitals.js` imports `esc`/`fmtDate` from `views.js`, and now `views.js` imports from `vitals.js`. ES modules tolerate this cycle because all uses are inside functions called after both modules evaluate — but verify the syntax check and the browser console stay clean. If the cycle misbehaves (it shouldn't), move `esc`/`fmtDate` into a new `js/fmt.js` and update both importers plus `sw.js` ASSETS.

- [ ] **Step 2: Browser test**

`<scratch>/t4-report.js` (harness, port 8133): create member → add one weight reading (as in T3) → navigate back → open Doctor report → assert `text=Recent vitals` and `text=Weight 14.2 kg` visible. Expected: `T4 PASS`.

- [ ] **Step 3: Commit**

```bash
git add js/views.js css/style.css
git commit -m "feat: recent vitals on the doctor report"
```

---

### Task 5: Backup format v2 — photos + vitals round-trip

**Files:**
- Modify: `js/backup.js`
- Test: `<scratch>/t5-backup.js`

**Interfaces:**
- Consumes: `importData({members, records, vitals, photos}, mode)` from Task 1.
- Produces: backup JSON with `schemaVersion: 2`, `vitals: [...]`, `photos: [{id, recordId, createdAt, mime, data(base64)}]`.

- [ ] **Step 1: Rework backup.js**

Set `SCHEMA_VERSION = 2`. Add blob/base64 helpers:

```js
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
```

`exportBackup`: also `getAll('vitals')` and `getAll('photos')`; serialize photos as
`{ id, recordId, createdAt, mime: p.blob.type, data: await blobToBase64(p.blob) }`. Payload gains `vitals` and `photos` keys.

`parseBackupFile`: keep existing checks; `schemaVersion > SCHEMA_VERSION` still rejected. Add: if `data.vitals` present it must be an array; if `data.photos` present it must be an array and every entry needs string `id`, `recordId`, `data`. Default both to `[]` when absent (v1 compatibility).

`importBackup`: convert photos back to blob objects before the DB write:

```js
export async function importBackup(data, mode) {
  const photos = (data.photos || []).map((p) => ({
    id: p.id, recordId: p.recordId, createdAt: p.createdAt || '',
    blob: base64ToBlob(p.data, p.mime),
  }));
  return importData({ members: data.members, records: data.records,
    vitals: data.vitals || [], photos }, mode);
}
```

In `views.js` homeView, the import-choice dialog counts should mention the new data:
change the summary line to `${data.members.length} members, ${data.records.length} records, ${(data.vitals || []).length} vitals, ${(data.photos || []).length} photos`. The post-import success message can keep members/records counts.

- [ ] **Step 2: Browser test — full round trip**

`<scratch>/t5-backup.js` (harness, port 8134): seed a member + a record with one attached photo (as in T2) + one weight reading (as in T3). Then:

```js
// export → capture download to a temp file
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.goto('http://localhost:8134/#/').then(() => page.click('#btn-export')),
]);
const backupPath = path.join(__dirname, 'roundtrip.json');
await download.saveAs(backupPath);
const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
console.log('schema:', parsed.schemaVersion, 'photos:', parsed.photos.length, 'vitals:', parsed.vitals.length);
// wipe site data
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase('fht'); req.onsuccess = res; req.onblocked = res;
}));
await page.reload();
await page.waitForSelector('text=Add family member');
// import replace
page.on('dialog', (d) => d.accept());
await page.click('#btn-import');
await page.setInputFiles('#import-file', backupPath);
await page.waitForSelector('#btn-replace');
await page.click('#btn-replace');
await page.waitForSelector('text=Restored');
await page.waitForSelector('text=Photo Tester');
// verify restored photo + vital
const counts = await page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('fht'); r.onsuccess = () => res(r.result); });
  const count = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => res(q.result); });
  const out = { photos: await count('photos'), vitals: await count('vitals') };
  db.close(); return out;
});
console.log('restored:', JSON.stringify(counts));
if (parsed.schemaVersion !== 2 || counts.photos !== 1 || counts.vitals !== 1) { console.error('T5 FAIL'); process.exit(1); }
console.log('T5 PASS');
```

Note: `deleteDatabase` requires the page's own connection closed — the app keeps one open, so `page.reload()` alone won't release it before delete resolves; run the delete via `req.onblocked = res` fallback then reload (as written above) and confirm the empty state appears; if the old data survives, close the connection first by navigating to `about:blank` before deleting.

Also verify v1 compatibility: write a minimal v1 JSON (`schemaVersion: 1`, members+records only) to disk, import it with Merge, expect the success message.

Expected: `T5 PASS`.

- [ ] **Step 3: Commit**

```bash
git add js/backup.js js/views.js
git commit -m "feat: backup format v2 with photos (base64) and vitals; v1 import compat"
```

---

### Task 6: Service worker, regression pass, deploy

**Files:**
- Modify: `sw.js`, `README.md`
- Test: full v1 smoke suite + offline test rerun

- [ ] **Step 1: Bump the service worker**

`sw.js`: change `const CACHE = 'fht-v1'` to `'fht-v2'`; add `'./js/photos.js'` and `'./js/vitals.js'` to ASSETS (and `'./js/fmt.js'` if Task 4's cycle fallback was used).

- [ ] **Step 2: README note**

In README's feature list add: photo attachments (compressed, on-device, included in backups) and vitals tracking with charts. Note backups containing photos are larger.

- [ ] **Step 3: Full regression**

Re-run the v1 smoke suite (member/records/search/report/backup/home flows) and the PWA offline test (SW registers, precache count = 14 assets, offline reload works, and the old `fht-v1` cache is deleted after activation). Then re-run t2, t3, t5 once more on the final code. All must pass.

- [ ] **Step 4: Commit and deploy**

```bash
git add sw.js README.md
git commit -m "chore: bump service worker cache to fht-v2 with new modules"
git push origin main
```

Deployment note for the user: the update reaches installed phones within ~10 minutes and applies on the next app launch. Existing on-phone data upgrades in place (IndexedDB v1→v2 migration adds the new stores without touching records).
