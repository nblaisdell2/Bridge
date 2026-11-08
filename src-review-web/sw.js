// Bridge Review service worker: lets the phone app open and play downloaded songs with no connection.

// Replaced with a hash of the app's files by copy-static.js, so that every change to them installs as a new version
const SHELL_VERSION = '__SHELL_VERSION__'
const SHELL_CACHE = `bridge-review-shell-${SHELL_VERSION}`
const MEDIA_CACHE = 'bridge-review-media' // Filled by app.js when songs are downloaded
const SHELL_FILES = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon-256.png', 'icon-512.png']

self.addEventListener('install', event => {
	// All or nothing, because the page, script, and styles only work with each other. If a file can't be downloaded,
	// this version is discarded, the previous one keeps working, and the browser tries again the next time the app opens.
	event.waitUntil(
		caches.open(SHELL_CACHE)
			.then(cache => cache.addAll(SHELL_FILES.map(file => new Request(file, { cache: 'reload' }))))
			.then(() => self.skipWaiting())
	)
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

	// App shell: always this version's complete copy (Bridge may be unreachable). Updates arrive as a new version.
	event.respondWith(caches.open(SHELL_CACHE).then(cache => cache.match(request, { ignoreSearch: true })).then(cached => cached ?? fetch(request)))
})
