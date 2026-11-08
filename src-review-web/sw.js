// Bridge Review service worker: lets the phone app open and play downloaded songs with no connection.

const SHELL_CACHE = 'bridge-review-shell-v2'
const MEDIA_CACHE = 'bridge-review-media' // Filled by app.js when songs are downloaded
const SHELL_FILES = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon-256.png', 'icon-512.png']

self.addEventListener('install', event => {
	event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(key => key.startsWith('bridge-review-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key))))
			.then(() => self.clients.claim())
	)
})

self.addEventListener('fetch', event => {
	const request = event.request
	const url = new URL(request.url)
	if (request.method !== 'GET' || url.origin !== self.location.origin) { return }

	// Downloaded clips and album art
	if (url.pathname.startsWith('/api/clip/') || url.pathname.startsWith('/api/art/')) {
		event.respondWith(caches.open(MEDIA_CACHE).then(cache => cache.match(request)).then(cached => cached ?? fetch(request)))
		return
	}

	// The JSON API always needs Bridge
	if (url.pathname.startsWith('/api/')) { return }

	// App shell: answer from cache immediately (Bridge may be unreachable), refresh it in the background
	event.respondWith(caches.open(SHELL_CACHE).then(async cache => {
		const cached = await cache.match(request, { ignoreSearch: true })
		const refresh = fetch(request)
			.then(response => {
				if (response.ok) { cache.put(request, response.clone()) }
				return response
			})
			.catch(() => cached)
		return cached ?? refresh
	}))
})
