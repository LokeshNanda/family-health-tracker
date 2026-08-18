# Design: Photo Attachments & Vitals Tracking (v2)

**Date:** 2026-08-18
**Status:** Approved in design discussion; spec for implementation planning.

## Context

The Family Health Tracker PWA (v1, shipped 2026-08-18) tracks symptoms, doctor visits, and medications per family member, fully on-device (IndexedDB), with JSON backup and a printable doctor report. Two features were deferred from v1 and are now being built:

1. **Photo attachments** — attach camera/gallery photos (prescriptions, lab reports) to any record. Records already carry a reserved `attachments: []` field.
2. **Vitals tracking** — log weight, blood pressure, blood sugar, and temperature per member over time, with simple charts.

Constraints unchanged from v1: plain HTML/CSS/vanilla JS, no dependencies, no build step, all data on-device, offline-capable, hosted on GitHub Pages.

## Decisions made with the user

- All four vital types: weight (kg), blood pressure (systolic/diastolic mmHg), blood sugar (mg/dL with fasting/post-meal/random context), temperature (°F).
- Vitals display: SVG line chart per type above the reading list.
- Photos ARE included in the JSON backup (as base64) — completeness over file size.

## Data model

IndexedDB `fht` bumps **version 1 → 2**. `onupgradeneeded` creates two stores (existing stores untouched):

### `photos` store
```js
{
  id,            // UUID (crypto.randomUUID, existing fallback)
  recordId,      // owning record
  blob,          // compressed image Blob (JPEG)
  createdAt,     // ISO timestamp
}
```
Index: `recordId`.

**Compression on save:** draw onto a canvas capped at 1600 px on the long edge, export `image/jpeg` at quality 0.8 (≈100–300 KB typical). Original file is never stored.

`record.attachments` becomes an array of photo IDs (already `[]` on all existing records — no record migration needed).

### `vitals` store
```js
{
  id, memberId,
  type,          // "weight" | "bp" | "sugar" | "temp"
  date,          // "YYYY-MM-DD" (same convention as records: lexicographic sort, no Date parsing)
  time,          // "HH:MM" or "" — optional; enables same-day fever curves
  value,         // number — weight kg / sugar mg/dL / temp °F; unused for bp
  systolic, diastolic,  // numbers — bp only
  context,       // sugar only: "fasting" | "post-meal" | "random" | ""
  createdAt,
}
```
Index: compound `byMemberTypeDate` on `[memberId, type, date]` (range query per member+type returns date-sorted, same pattern as records' `byMemberDate`).

### Cascades
- Deleting a record deletes its photos (via `recordId` index) in the same transaction.
- Deleting a member (existing cascade) additionally deletes photos of each of their records and all their vitals — one transaction over `[members, records, photos, vitals]`.

## Photo UX

- **Record form** (new + edit, all three record types): "Add photo" button backed by `<input type="file" accept="image/*" capture="environment" multiple>` — phone offers camera or gallery. Selected images are compressed immediately and shown as thumbnails with a remove ✕. Photos persist when the form is saved; removing a thumbnail on an existing record deletes the photo on save. Adding photos on a new record: photos are saved after the record (ids collected first, written together).
- **Timeline card**: small 📎 badge with photo count when `attachments.length > 0`.
- **Viewer**: tapping a thumbnail (in the edit form) opens a full-screen overlay (`<dialog>` or fixed-position div) showing the image via a temporary object URL; tap/✕ to close. Object URLs revoked on close.
- **Print/report**: photos are NOT printed; excluded entirely from the report view.

## Vitals UX

- **Entry point**: "Vitals" button in the member screen's action row (next to Edit profile / Doctor report).
- **Route**: `#/member/:id/vitals` (one new route in app.js).
- **Screen layout**: four filter tabs (Weight / BP / Sugar / Temp — reuse chip styling); below the active tab:
  1. **SVG line chart** of that type's readings, oldest → newest on x. BP renders two lines (systolic, diastolic). Hand-rolled inline SVG (~60 lines): scaled polyline + dots, min/max/latest labels, no external libraries. Chart hidden when fewer than 2 readings.
  2. **Add-reading form** inline: date (default today), optional time, the type-specific value field(s), Save.
  3. **Reading list** newest first: value, date (+time), context badge for sugar; each row deletable (confirm()).
- **Doctor report**: new "Recent vitals" section after the header — the latest reading of each type that has data, with its date (e.g., "Weight 14.2 kg (12 Aug 2026) · BP 118/76 (10 Aug 2026)"). Chronological history section unchanged.
- **Search**: vitals are NOT searchable (numeric data; out of scope).

## Backup format v2

`schemaVersion: 2`. Adds two arrays:

```json
{
  "app": "family-health-tracker",
  "schemaVersion": 2,
  "exportedAt": "...",
  "members": [...], "records": [...],
  "vitals": [...],
  "photos": [{ "id", "recordId", "createdAt", "mime": "image/jpeg", "data": "<base64>" }]
}
```

- **Export**: blobs converted to base64 (FileReader/arrayBuffer). Note in the UI that backups with photos can be large.
- **Import**: v1 backups (schemaVersion 1, no vitals/photos keys) still import fine — missing arrays treated as empty. v2 validation extends the existing checks (vitals/photos must be arrays if present; each photo needs id/recordId/data). Merge/replace semantics unchanged, extended over all four stores in one transaction. Base64 → Blob on import.
- The existing "backup made by a newer version" guard stays (schemaVersion > 2 rejected).

## Files touched

| File | Change |
|---|---|
| `js/photos.js` (new) | compressImage(file) → Blob; photo store CRUD; thumbnail/object-URL helpers; full-screen viewer |
| `js/vitals.js` (new) | vitals view (tabs, form, list), SVG chart renderer, vitals store queries |
| `js/db.js` | DB_VERSION 2; create `photos` + `vitals` stores in upgrade; extend member cascade; record-delete cascade helper |
| `js/views.js` | record form: photo picker + thumbnails; record delete → photo cascade; timeline 📎 badge; member screen Vitals button; report Recent-vitals section |
| `js/backup.js` | schemaVersion 2 export/import incl. base64 photo round-trip; v1 import compatibility |
| `js/app.js` | route `#/member/:id/vitals` |
| `css/style.css` | thumbnails, viewer overlay, vitals tabs/chart/list styles (print: hide vitals chart chrome, keep Recent-vitals text) |
| `sw.js` | add `js/photos.js`, `js/vitals.js` to ASSETS; **bump CACHE `fht-v1` → `fht-v2`** |

## Error handling

- Image decode/compression failure → inline error on the form ("Couldn't read that image"), record still savable without it.
- IndexedDB quota exceeded on photo save → surface the browser error inline; record saves without the photo.
- Vitals form validates numeric fields (positive numbers; BP requires both values).
- Import of malformed v2 backups rejected before any DB write (existing pattern).

## Testing

Browser-automation smoke tests (Playwright-core + Edge, same harness as v1):
1. Attach a generated PNG to a new symptom record → thumbnail renders, 📎 badge on timeline, viewer opens, photo present in IndexedDB.
2. Delete the record → photo gone from IndexedDB. Member cascade also removes photos + vitals.
3. Add readings for all four vital types → tabs switch, chart SVG renders with ≥2 points, BP shows two lines, list ordered newest first, delete works.
4. Report shows Recent vitals line.
5. Export v2 backup → wipe site data → import (replace) → photos and vitals restored byte-comparable; import same file again (merge) → no duplicates. Import a v1-format backup → succeeds.
6. Offline reload still works after CACHE bump; old cache deleted.

## Out of scope

Photos in the printed report, vitals in search, chart date-range pickers, photo annotation/cropping, standalone documents not attached to a record, units configuration (kg/°F fixed).
