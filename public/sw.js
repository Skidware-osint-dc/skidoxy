importScripts('/scram/scramjet.all.js');
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const engine = new ScramjetServiceWorker();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => event.respondWith((async () => {
  await engine.loadConfig();
  return engine.route(event) ? engine.fetch(event) : fetch(event.request);
})()));
