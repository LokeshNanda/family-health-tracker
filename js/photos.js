// photos.js — on-device photo attachments: compression, storage, picker UI, viewer.

import { uuid, put, del, openDB } from './db.js';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

// Downscale to MAX_EDGE on the long side, re-encode as JPEG.
// imageOrientation honors the camera's EXIF rotation (no-op where auto-applied).
export async function compressImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
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

// Full-screen photo viewer overlay. Takes all of a record's photo blobs and a
// start index: swipe (touch), arrow keys or the ‹ › buttons move between them.
// Self-cleaning: closes (and revokes its object URLs) on tap, the ✕ button,
// Escape, or any navigation (hashchange / back button).
export function openViewer(blobs, startIndex = 0) {
  const list = Array.isArray(blobs) ? blobs : [blobs];
  const multi = list.length > 1;
  const urls = list.map(() => null); // object URLs created on first view
  let i = 0;

  const overlay = document.createElement('div');
  overlay.className = 'photo-viewer';
  overlay.innerHTML = `
    <img alt="Attached photo">
    <button class="photo-viewer-close" aria-label="Close">&#10005;</button>
    ${multi ? `
      <button type="button" class="photo-viewer-nav photo-viewer-prev" aria-label="Previous photo">&#8249;</button>
      <button type="button" class="photo-viewer-nav photo-viewer-next" aria-label="Next photo">&#8250;</button>
      <span class="photo-viewer-count"></span>` : ''}`;
  const img = overlay.querySelector('img');
  const countEl = overlay.querySelector('.photo-viewer-count');

  function show(n) {
    i = (n + list.length) % list.length;
    if (!urls[i]) urls[i] = URL.createObjectURL(list[i]);
    img.src = urls[i];
    if (countEl) countEl.textContent = `${i + 1} / ${list.length}`;
  }

  const close = () => {
    urls.forEach((u) => u && URL.revokeObjectURL(u));
    overlay.remove();
    window.removeEventListener('hashchange', close);
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (multi && e.key === 'ArrowLeft') show(i - 1);
    else if (multi && e.key === 'ArrowRight') show(i + 1);
  };

  // Some browsers fire a click after a touch sequence; a swipe must navigate,
  // not fall through to the click-to-close below.
  let touchX = null;
  let touchY = null;
  let swiped = false;
  overlay.addEventListener('touchstart', (e) => {
    swiped = false;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  overlay.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = touchY = null;
    if (multi && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      swiped = true;
      show(dx < 0 ? i + 1 : i - 1);
    }
  }, { passive: true });

  overlay.addEventListener('click', () => {
    if (swiped) { swiped = false; return; }
    close();
  });
  overlay.querySelectorAll('.photo-viewer-nav').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      show(btn.classList.contains('photo-viewer-prev') ? i - 1 : i + 1);
    });
  });

  window.addEventListener('hashchange', close);
  window.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  show(startIndex);
}

// Renders thumbnails + "Add photo" into containerEl. Tracks pending adds and removals.
// commit(recordId) persists the changes and returns the final photo-id array.
export async function photoPicker(containerEl, existingRecordId) {
  const existing = existingRecordId ? await getPhotosForRecord(existingRecordId) : [];
  const kept = new Map(existing.map((p) => [p.id, p]));
  const added = [];
  const objectUrls = [];

  containerEl.innerHTML = `
    <div class="photo-thumbs"></div>
    <label class="btn btn-ghost btn-sm photo-add-btn">&#128247; Add photo
      <input type="file" accept="image/*" multiple hidden>
    </label>
    <p class="error photo-error" hidden></p>`;
  const thumbs = containerEl.querySelector('.photo-thumbs');
  const fileInput = containerEl.querySelector('input[type="file"]');
  const errEl = containerEl.querySelector('.photo-error');

  function revokeAll() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls.length = 0;
  }
  // Abandoned form (back button / navigation) frees the preview URLs.
  window.addEventListener('hashchange', revokeAll, { once: true });

  function renderThumb(blob, key, isExisting) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    wrap.innerHTML = `<img src="${url}" alt="Attachment"><button type="button" class="photo-remove" aria-label="Remove photo">&#10005;</button>`;
    wrap.querySelector('img').addEventListener('click', () => {
      // Thumbnail order: kept existing photos first, then pending adds.
      const current = [
        ...existing.filter((p) => kept.has(p.id)).map((p) => p.blob),
        ...added.map((a) => a.blob),
      ];
      openViewer(current, Math.max(0, current.indexOf(blob)));
    });
    wrap.querySelector('.photo-remove').addEventListener('click', () => {
      if (isExisting) kept.delete(key);
      else added.splice(added.findIndex((a) => a.key === key), 1);
      URL.revokeObjectURL(url);
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
      revokeAll();
      return ids;
    },
  };
}
