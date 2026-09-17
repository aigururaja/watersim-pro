/*
 * SafeKrit service worker — deliberately small.
 *
 * It exists so the site is installable (and so the Android app, a Trusted Web
 * Activity, has something to show with no network). It handles page
 * NAVIGATIONS only: network first, and when the network is gone the offline
 * page. It never touches /api, /ws, the hashed build assets or anything else,
 * so it cannot serve a stale build or a stale reading: a plant screen must
 * either be live or say plainly that it is not.
 */
const CACHE = 'safekrit-shell-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return; // everything else goes straight to the network
  event.respondWith(
    fetch(req).catch(() => caches.match(OFFLINE_URL).then((res) => res || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))),
  );
});
