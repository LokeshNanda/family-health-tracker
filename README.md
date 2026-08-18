# Family Health Tracker

A private, phone-installable health diary for your family. Plain HTML/CSS/JS — no build step, no dependencies, no backend.

- **Everything stays on your device.** Records live in your browser's IndexedDB; the hosted site is just the app shell.
- Track **symptoms/illness, doctor visits and medications** per family member on a timeline.
- Attach **photos** (prescriptions, lab reports) to any record — compressed and stored on-device, viewable full-screen.
- Track **vitals** (weight, blood pressure, blood sugar, temperature) per person, with trend charts.
- **Search** everything ("azithromycin" → every time it was taken, newest first).
- **Doctor report**: a clean printable summary per person (use Print / Save as PDF).
- **Backup**: export/import all data as a JSON file (photos included, so backups with many photos get large). Since data is on-device only, export regularly — it's your only safety net if the phone is lost.

## Run locally

```
python -m http.server 8000
# then open http://localhost:8000
```

## Deploy (GitHub Pages)

Push to `main` with Pages enabled (Settings → Pages → Deploy from branch → `main` / root).

> **Before every deploy: bump the `CACHE` version string at the top of `sw.js`** (e.g. `fht-v1` → `fht-v2`). If you forget, phones keep serving the old cached version. Updates reach installed apps within ~10 minutes and apply on the next launch.

## Install on your phone

Open the site → browser menu → **Add to Home Screen** (Android Chrome offers Install; iPhone: Safari → Share → Add to Home Screen). It then launches full-screen and works offline.
