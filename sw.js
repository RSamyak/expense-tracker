// Keeps the app's own files, so it opens without a signal.  Fresh copies win whenever the network answers.
const CACHE = "expenses-2";
const SHELL = ["./", "./ledger.js", "./store.js", "./github.js", "./folder.js", "./sync.js"];

addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));

addEventListener("activate", (event) =>
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));

addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request, { cache: "no-cache", signal: AbortSignal.timeout(4000) });
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return (await cache.match(request, { ignoreSearch: true })) ?? Response.error();
    }
  })());
});
