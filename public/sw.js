// Minimal offline shell for SVault. API and uploads always go to the network.
const CACHE = "svault-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/", copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => (await caches.match("/")) ?? caches.match(request)),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/tesseract/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          }),
      ),
    );
  }
});

/* Web Push. The payload is deliberately small: a title, a short body and the
   in-app path to open. Nothing else is trusted or displayed. */
/**
 * A notification may only open a page of this app: one leading slash, never
 * `//host` (which resolves to another origin) or `/\\host`.
 */
function inAppPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title.slice(0, 120) : "SVault";
  const body = typeof payload.body === "string" ? payload.body.slice(0, 240) : "";
  const url = inAppPath(payload.url) ? payload.url : "/notifications";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const stored = event.notification.data && event.notification.data.url;
  const target = new URL(inAppPath(stored) ? stored : "/notifications", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // Reuse the open tab and point it at the reminder. navigate() is not in
        // every engine, so fall back to focusing the tab that is already there.
        if ("navigate" in client) {
          try {
            await client.navigate(target);
          } catch {
            /* keep the focused tab */
          }
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
