/* ============================================================
   Service Worker — Termómetro DataBase (PWA)

   Estrategias:
   · Páginas propias (.html, "/")   → RED PRIMERO (siempre la versión nueva;
                                       si no hay internet, usa la copia guardada)
   · Otros archivos propios         → cache + actualización en segundo plano
   · CDN (Tailwind, Chart.js, ...)  → cache + actualización en segundo plano
   · Worker de Cloudflare y demás   → NUNCA se guardan; van siempre a la red

   Cuándo subir CACHE_VERSION: solo si cambias la lista de archivos
   o las versiones de las librerías CDN. Los cambios en index.html o
   grafica.html NO necesitan subir el número.
   ============================================================ */

const CACHE_VERSION = "termometro-v1";
const NETWORK_TIMEOUT_MS = 4000;

const LOCAL_ASSETS = [
  "./",
  "./index.html",
  "./grafica.html",
  "./manifest.json",
  "./icono.svg"
];

/* Deben coincidir EXACTAMENTE con las URLs de los <script> de las páginas */
const CDN_ASSETS = [
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js",
  "https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"
];

const CDN_HOSTS = ["cdn.tailwindcss.com", "cdn.jsdelivr.net"];

/* ---------- Instalación: guarda lo imprescindible (si algo falla, no se cae todo) ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);

    await Promise.allSettled([
      ...LOCAL_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" }))),
      ...CDN_ASSETS.map(async (url) => {
        // no-cors devuelve una respuesta "opaca"; cache.add la rechaza, cache.put sí la acepta
        const res = await fetch(new Request(url, { mode: "no-cors" }));
        await cache.put(url, res);
      })
    ]);

    await self.skipWaiting();
  })());
});

/* ---------- Activación: borra caches de versiones anteriores ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------- Peticiones ---------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;             // POST /save y demás: red directa

  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    const isPage = req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/");
    event.respondWith(isPage ? networkFirst(req) : staleWhileRevalidate(event, req));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, req));
    return;
  }

  // Cualquier otro origen (incluido *.workers.dev): no se intercepta, va a la red
});

/* ---------- Estrategias ---------- */

async function fetchWithTimeout(req, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    // no-cache: obliga a revalidar con el servidor y no usar la copia HTTP de 10 min de GitHub Pages
    return await fetch(req, { signal: controller.signal, cache: "no-cache" });
  } finally {
    clearTimeout(timer);
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const cached = await cache.match(req, { ignoreSearch: true });   // grafica.html?hours=4 → grafica.html
    if (cached) return cached;

    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return Response.error();
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);

  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);      // actualiza la copia en segundo plano
    return cached;
  }

  const res = await network;
  return res || Response.error();
}
