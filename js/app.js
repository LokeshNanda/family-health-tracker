// app.js — entry point: hash router, top bar wiring, service worker registration.

import { openDB } from './db.js';
import {
  homeView, memberView, memberFormView, recordFormView, searchView, reportView,
} from './views.js';
import { vitalsView } from './vitals.js';
import { vaccinesView } from './vaccines.js';

const app = document.getElementById('app');

// Order matters: literal segments (new, edit) before the catch-all member route.
const ROUTES = [
  [/^#\/$/, () => homeView(app)],
  [/^#\/search$/, () => searchView(app)],
  [/^#\/member\/new$/, () => memberFormView(app, null)],
  [/^#\/member\/([^/]+)\/edit$/, (id) => memberFormView(app, id)],
  [/^#\/member\/([^/]+)\/record\/new\/(symptom|visit|medication)$/,
    (memberId, type) => recordFormView(app, { memberId, type })],
  [/^#\/member\/([^/]+)\/vitals(?:\/(weight|bp|sugar|temp|height))?$/,
    (id, type) => vitalsView(app, id, type || 'weight')],
  [/^#\/member\/([^/]+)\/vaccines$/, (id) => vaccinesView(app, id)],
  [/^#\/member\/([^/]+)$/, (id) => memberView(app, id)],
  [/^#\/record\/([^/]+)\/edit$/, (recordId) => recordFormView(app, { recordId })],
  [/^#\/report\/([^/]+)$/, (id) => reportView(app, id)],
];

async function route() {
  const hash = location.hash || '#/';
  for (const [pattern, handler] of ROUTES) {
    const match = hash.match(pattern);
    if (match) {
      try {
        await handler(...match.slice(1).map((p) => (p === undefined ? p : decodeURIComponent(p))));
      } catch (err) {
        app.innerHTML = `<div class="empty"><p class="empty-title">Something went wrong.</p><p>Go back home and try again.</p><a class="btn btn-primary" href="#/">Home</a></div>`;
        console.error(err);
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

document.getElementById('btn-back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.hash = '#/';
});

window.addEventListener('hashchange', route);

async function start() {
  try {
    await openDB();
  } catch (err) {
    app.innerHTML = `<div class="empty"><p class="empty-title">Can't open your health book.</p>
      <p>This browser is blocking local storage (this can happen in private/incognito windows).
      Open the app in a normal browser window and try again.</p></div>`;
    return;
  }
  // Ask the browser not to evict our data (best-effort; matters most on iOS).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  await route();
}

start();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
