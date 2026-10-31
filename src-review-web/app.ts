/**
 * Bridge Review - phone app
 * Plays a preview clip for each song and records keep/skip decisions, fully offline.
 * Songs (metadata in IndexedDB, clips + art in Cache Storage) are downloaded in batches from Bridge,
 * and decisions wait in an outbox until Bridge can be reached again.
 *
 * The API types mirror src-shared/interfaces/review.interface.ts (this app is compiled on its own).
 */

interface BatchSong {
	songKey: string
	artist: string
	name: string
	album: string
	genre: string
	year: string
	songLength: number | null
	chartCount: number
	charters: string
	clipUrl: string
	artUrl: string | null
}

interface QueuedSong extends BatchSong {
	order: number
}

interface Decision {
	songKey: string
	status: 'keep' | 'skip' | 'pending'
	decidedAt: string
}

interface OutboxEntry extends Decision {
	id?: number
}

interface Stats {
	total: number
	pending: number
	keep: number
	skip: number
	owned: number
	clipsReady: number
	lastSyncAt: string | null
}

const DB_NAME = 'bridge-review'
const MEDIA_CACHE = 'bridge-review-media'
const UNDO_LIMIT = 30
const REQUEST_TIMEOUT_MS = 15000
const DOWNLOAD_CONCURRENCY = 4
const QUIET_TOP_UP_SIZE = 50
const SWIPE_THRESHOLD_PX = 110

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const elements = {
	card: $<HTMLElement>('card'),
	art: $<HTMLImageElement>('art'),
	artFallback: $<HTMLElement>('art-fallback'),
	name: $<HTMLElement>('song-name'),
	artist: $<HTMLElement>('song-artist'),
	details: $<HTMLElement>('song-details'),
	charts: $<HTMLElement>('song-charts'),
	play: $<HTMLButtonElement>('play'),
	progressFill: $<HTMLElement>('progress-fill'),
	empty: $<HTMLElement>('empty'),
	emptyTitle: $<HTMLElement>('empty-title'),
	emptyBody: $<HTMLElement>('empty-body'),
	offlineCount: $<HTMLElement>('offline-count'),
	serverCount: $<HTMLElement>('server-count'),
	outboxBadge: $<HTMLElement>('outbox-badge'),
	undo: $<HTMLButtonElement>('undo'),
	keep: $<HTMLButtonElement>('keep'),
	skip: $<HTMLButtonElement>('skip'),
	later: $<HTMLButtonElement>('later'),
	toast: $<HTMLElement>('toast'),
	toastText: $<HTMLElement>('toast-text'),
	syncDialog: $<HTMLDialogElement>('sync-dialog'),
	syncStatus: $<HTMLElement>('sync-status'),
	syncProgress: $<HTMLElement>('sync-progress'),
	syncProgressFill: $<HTMLElement>('sync-progress-fill'),
	syncNow: $<HTMLButtonElement>('sync-now'),
	batchSize: $<HTMLSelectElement>('batch-size'),
	audio: $<HTMLAudioElement>('audio'),
}

let db: IDBDatabase
let queue: QueuedSong[] = []
let undoStack: Array<{ song: QueuedSong; status: Decision['status'] }> = []
let outboxCount = 0
let stats: Stats | null = null
let currentObjectUrls: string[] = []
let syncing = false
let toastTimer: number | undefined
let quietSyncTimer: number | undefined

// ---------- IndexedDB ----------

function openDb() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1)
		request.onupgradeneeded = () => {
			const database = request.result
			database.createObjectStore('queue', { keyPath: 'songKey' })
			database.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
			database.createObjectStore('meta', { keyPath: 'key' })
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

function store(name: 'queue' | 'outbox' | 'meta', mode: IDBTransactionMode = 'readonly') {
	return db.transaction(name, mode).objectStore(name)
}

function promisify<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

async function getMeta<T>(key: string): Promise<T | null> {
	const row = await promisify(store('meta').get(key)) as { key: string; value: T } | undefined
	return row?.value ?? null
}

function setMeta(key: string, value: unknown) {
	return promisify(store('meta', 'readwrite').put({ key, value }))
}

// ---------- Media cache ----------

const mediaCacheAvailable = 'caches' in window

async function cacheMedia(url: string) {
	if (!mediaCacheAvailable) { return }
	const cache = await caches.open(MEDIA_CACHE)
	if (await cache.match(url)) { return }
	const response = await fetchWithTimeout(url, { method: 'GET' }, 60000)
	if (!response.ok) { throw new Error(`HTTP ${response.status} for ${url}`) }
	await cache.put(url, response)
}

/** @returns an object URL for cached media, or the network URL when it isn't cached. */
async function mediaUrl(url: string) {
	if (mediaCacheAvailable) {
		const cached = await (await caches.open(MEDIA_CACHE)).match(url)
		if (cached) {
			const objectUrl = URL.createObjectURL(await cached.blob())
			currentObjectUrls.push(objectUrl)
			return objectUrl
		}
	}
	return url
}

async function deleteMedia(song: BatchSong) {
	if (!mediaCacheAvailable) { return }
	const cache = await caches.open(MEDIA_CACHE)
	await cache.delete(song.clipUrl)
	// Album art is shared between songs of the same album, so only delete it when unused
	if (song.artUrl && !queue.some(s => s.artUrl === song.artUrl) && !undoStack.some(u => u.song.artUrl === song.artUrl)) {
		await cache.delete(song.artUrl)
	}
}

/** Removes cached media that no queued (or undoable) song refers to. */
async function pruneMedia() {
	if (!mediaCacheAvailable) { return }
	const cache = await caches.open(MEDIA_CACHE)
	const keep = new Set<string>()
	for (const song of [...queue, ...undoStack.map(u => u.song)]) {
		keep.add(new URL(song.clipUrl, location.href).href)
		if (song.artUrl) { keep.add(new URL(song.artUrl, location.href).href) }
	}
	for (const request of await cache.keys()) {
		if (!keep.has(request.url)) { await cache.delete(request) }
	}
}

// ---------- Network ----------

async function fetchWithTimeout(url: string, init: RequestInit, timeout = REQUEST_TIMEOUT_MS) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeout)
	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} finally {
		clearTimeout(timer)
	}
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
	const response = await fetchWithTimeout(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!response.ok) { throw new Error(`HTTP ${response.status}`) }
	return await response.json() as T
}

/** Sends queued decisions and drops cached songs that were decided elsewhere. */
async function syncDecisions() {
	const outbox = await promisify(store('outbox').getAll()) as OutboxEntry[]
	const result = await postJson<{ removedKeys: string[]; stats: Stats }>('api/sync', {
		decisions: outbox.map(({ songKey, status, decidedAt }) => ({ songKey, status, decidedAt })),
		cachedKeys: queue.map(s => s.songKey),
	})

	const outboxStore = store('outbox', 'readwrite')
	for (const entry of outbox) { outboxStore.delete(entry.id!) }
	await refreshOutboxCount()

	if (result.removedKeys.length > 0) {
		const removed = new Set(result.removedKeys)
		const current = queue[0]
		const removedSongs = queue.filter(s => removed.has(s.songKey))
		queue = queue.filter(s => !removed.has(s.songKey))
		const queueStore = store('queue', 'readwrite')
		for (const song of removedSongs) { queueStore.delete(song.songKey) }
		for (const song of removedSongs) { await deleteMedia(song) }
		if (current && removed.has(current.songKey)) { await showCurrent() }
	}

	stats = { ...result.stats, lastSyncAt: new Date().toISOString() }
	await setMeta('stats', stats)
	render()
}

/** Downloads songs until `targetCount` are stored on the device. */
async function downloadSongs(targetCount: number, onProgress?: (done: number, total: number) => void) {
	const needed = targetCount - queue.length
	if (needed <= 0) { return { added: 0, requested: 0 } }

	const batch = await postJson<{ songs: BatchSong[]; stats: Stats }>('api/batch', {
		count: needed,
		exclude: queue.map(s => s.songKey),
	})
	stats = { ...batch.stats, lastSyncAt: new Date().toISOString() }
	await setMeta('stats', stats)

	let done = 0
	let added = 0
	let next = 0
	const wasEmpty = queue.length === 0
	await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
		while (next < batch.songs.length) {
			const song = batch.songs[next++]
			try {
				await cacheMedia(song.clipUrl)
				if (song.artUrl) { await cacheMedia(song.artUrl).catch(() => song.artUrl = null) }
				const queued: QueuedSong = { ...song, order: maxOrder() + 1 }
				queue.push(queued)
				await promisify(store('queue', 'readwrite').put(queued))
				added++
			} catch (err) {
				console.warn('Failed to download', song.name, err)
			}
			onProgress?.(++done, batch.songs.length)
			if (wasEmpty && added === 1) { await showCurrent() }
			render()
		}
	}))
	return { added, requested: needed }
}

async function fullSync() {
	if (syncing) { return }
	syncing = true
	elements.syncNow.disabled = true
	elements.syncProgress.hidden = false
	elements.syncProgressFill.style.width = '0%'
	const targetCount = Number(elements.batchSize.value)
	await setMeta('batchSize', targetCount)
	try {
		elements.syncStatus.textContent = 'Sending your decisions to Bridge...'
		await syncDecisions()
		elements.syncStatus.textContent = 'Downloading songs...'
		const result = await downloadSongs(targetCount, (done, total) => {
			elements.syncProgressFill.style.width = `${Math.round(done / total * 100)}%`
			elements.syncStatus.textContent = `Downloading songs (${done} of ${total})...`
		})
		await pruneMedia()
		elements.syncProgressFill.style.width = '100%'
		const stillPreparing = result.added < result.requested && (stats?.pending ?? 0) > queue.length
		elements.syncStatus.textContent = stillPreparing
			? `Downloaded ${result.added} songs. Bridge is still preparing more clips, so sync again in a few minutes for the rest.`
			: `Up to date. ${queue.length} songs are ready on this phone.`
	} catch (err) {
		elements.syncStatus.textContent = `Couldn't reach Bridge (${err instanceof Error ? err.message : err}). Make sure Bridge is open on your PC and Tailscale is connected.`
	} finally {
		syncing = false
		elements.syncNow.disabled = false
		render()
	}
}

/** Flushes decisions in the background (and tops up a nearly empty queue) when Bridge is reachable. */
function scheduleQuietSync(delay = 3000) {
	clearTimeout(quietSyncTimer)
	quietSyncTimer = window.setTimeout(async () => {
		if (syncing) { return }
		syncing = true
		try {
			await syncDecisions()
			if (queue.length < QUIET_TOP_UP_SIZE / 2) { await downloadSongs(QUIET_TOP_UP_SIZE) }
		} catch {
			// Offline; decisions stay in the outbox
		} finally {
			syncing = false
			render()
		}
	}, delay)
}

// ---------- Review ----------

function maxOrder() {
	return queue.reduce((max, s) => Math.max(max, s.order), 0)
}

function minOrder() {
	return queue.reduce((min, s) => Math.min(min, s.order), 0)
}

async function showCurrent() {
	const song = queue[0]
	currentObjectUrls.forEach(u => URL.revokeObjectURL(u))
	currentObjectUrls = []
	elements.audio.pause()
	elements.card.style.transform = ''
	elements.card.style.opacity = '1'
	resetSwipeLabels()

	if (!song) {
		elements.audio.removeAttribute('src')
		render()
		return
	}

	elements.name.textContent = song.name
	elements.artist.textContent = song.artist
	elements.details.textContent = [song.album, song.year, song.genre, formatLength(song.songLength)].filter(v => v).join(' · ')
	elements.charts.textContent = `${song.chartCount} chart${song.chartCount === 1 ? '' : 's'}${song.charters ? ` · ${song.charters}` : ''}`
	elements.art.hidden = !song.artUrl
	elements.artFallback.hidden = !!song.artUrl
	if (song.artUrl) {
		elements.art.src = await mediaUrl(song.artUrl)
		elements.art.onerror = () => {
			elements.art.hidden = true
			elements.artFallback.hidden = false
		}
	}

	if ('mediaSession' in navigator) {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: song.name,
			artist: song.artist,
			album: song.album,
			artwork: song.artUrl ? [{ src: song.artUrl, sizes: '500x500', type: 'image/jpeg' }] : [],
		})
	}

	elements.audio.src = await mediaUrl(song.clipUrl)
	elements.audio.currentTime = 0
	elements.audio.play().catch(() => { /* Autoplay blocked until the first tap; the play button works */ })
	render()
}

async function decide(status: 'keep' | 'skip') {
	const song = queue[0]
	if (!song) { return }

	const decision: Decision = { songKey: song.songKey, status, decidedAt: new Date().toISOString() }
	await promisify(store('outbox', 'readwrite').add(decision))
	await promisify(store('queue', 'readwrite').delete(song.songKey))
	queue.shift()

	undoStack.push({ song, status })
	if (undoStack.length > UNDO_LIMIT) {
		const evicted = undoStack.shift()!
		await deleteMedia(evicted.song)
	}

	await refreshOutboxCount()
	showToast(`${status === 'keep' ? 'Kept' : 'Skipped'} “${song.name}”`)
	await animateOut(status === 'keep' ? 1 : -1)
	await showCurrent()
	scheduleQuietSync()
}

async function later() {
	const song = queue.shift()
	if (!song) { return }
	song.order = maxOrder() + 1
	queue.push(song)
	await promisify(store('queue', 'readwrite').put(song))
	await animateOut(0)
	await showCurrent()
}

async function undo() {
	const last = undoStack.pop()
	if (!last) { return }
	const decision: Decision = { songKey: last.song.songKey, status: 'pending', decidedAt: new Date().toISOString() }
	await promisify(store('outbox', 'readwrite').add(decision))
	last.song.order = minOrder() - 1
	queue.unshift(last.song)
	await promisify(store('queue', 'readwrite').put(last.song))
	await refreshOutboxCount()
	hideToast()
	await showCurrent()
	scheduleQuietSync()
}

function animateOut(direction: -1 | 0 | 1) {
	return new Promise<void>(resolve => {
		elements.card.classList.remove('dragging')
		elements.card.style.transform = direction === 0
			? 'translateY(-40px) scale(0.96)'
			: `translateX(${direction * 120}%) rotate(${direction * 18}deg)`
		elements.card.style.opacity = '0'
		setTimeout(resolve, 180)
	})
}

// ---------- Rendering ----------

async function refreshOutboxCount() {
	outboxCount = await promisify(store('outbox').count())
}

function render() {
	const hasSong = queue.length > 0
	elements.card.hidden = !hasSong
	elements.empty.hidden = hasSong
	elements.keep.disabled = elements.skip.disabled = elements.later.disabled = !hasSong
	elements.undo.disabled = undoStack.length === 0
	elements.offlineCount.textContent = `${queue.length.toLocaleString()} song${queue.length === 1 ? '' : 's'} ready`
	elements.outboxBadge.hidden = outboxCount === 0
	elements.outboxBadge.textContent = `${outboxCount}`

	if (stats) {
		elements.serverCount.textContent = `${stats.pending.toLocaleString()} left to review · ${stats.keep.toLocaleString()} kept`
			+ (stats.lastSyncAt ? ` · synced ${timeAgo(stats.lastSyncAt)}` : '')
	}

	if (!hasSong) {
		const allDone = stats !== null && stats.pending === 0
		elements.emptyTitle.textContent = allDone ? 'All caught up!' : 'No songs on this device'
		elements.emptyBody.textContent = allDone
			? 'Every song has been reviewed. New charts appear here after Bridge syncs with Chorus.'
			: 'Connect to your PC (through Tailscale) and download a batch of songs to review.'
	}
}

function showToast(text: string) {
	elements.toastText.textContent = text
	elements.toast.hidden = false
	clearTimeout(toastTimer)
	toastTimer = window.setTimeout(hideToast, 3500)
}

function hideToast() {
	elements.toast.hidden = true
}

function formatLength(ms: number | null) {
	if (!ms || ms <= 0) { return '' }
	const seconds = Math.round(ms / 1000)
	return `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, '0')}`
}

function timeAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000)
	if (minutes < 1) { return 'just now' }
	if (minutes < 60) { return `${minutes}m ago` }
	const hours = Math.round(minutes / 60)
	if (hours < 48) { return `${hours}h ago` }
	return `${Math.round(hours / 24)}d ago`
}

// ---------- Input ----------

function resetSwipeLabels() {
	for (const label of elements.card.querySelectorAll<HTMLElement>('.swipe-label')) { label.style.opacity = '0' }
}

function setUpSwipe() {
	let startX = 0
	let deltaX = 0
	let dragging = false
	const keepLabel = elements.card.querySelector<HTMLElement>('.swipe-label.keep')!
	const skipLabel = elements.card.querySelector<HTMLElement>('.swipe-label.skip')!

	elements.card.addEventListener('pointerdown', event => {
		if ((event.target as HTMLElement).closest('button')) { return }
		dragging = true
		startX = event.clientX
		deltaX = 0
		elements.card.classList.add('dragging')
		elements.card.setPointerCapture(event.pointerId)
	})
	elements.card.addEventListener('pointermove', event => {
		if (!dragging) { return }
		deltaX = event.clientX - startX
		elements.card.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 20}deg)`
		keepLabel.style.opacity = `${Math.max(0, Math.min(1, deltaX / SWIPE_THRESHOLD_PX))}`
		skipLabel.style.opacity = `${Math.max(0, Math.min(1, -deltaX / SWIPE_THRESHOLD_PX))}`
	})
	const end = () => {
		if (!dragging) { return }
		dragging = false
		elements.card.classList.remove('dragging')
		if (deltaX > SWIPE_THRESHOLD_PX) {
			decide('keep')
		} else if (deltaX < -SWIPE_THRESHOLD_PX) {
			decide('skip')
		} else {
			elements.card.style.transform = ''
			resetSwipeLabels()
		}
	}
	elements.card.addEventListener('pointerup', end)
	elements.card.addEventListener('pointercancel', end)
}

function setUpControls() {
	elements.keep.addEventListener('click', () => decide('keep'))
	elements.skip.addEventListener('click', () => decide('skip'))
	elements.later.addEventListener('click', () => later())
	elements.undo.addEventListener('click', () => undo())
	$('toast-undo').addEventListener('click', () => undo())
	elements.play.addEventListener('click', () => {
		if (elements.audio.paused) {
			elements.audio.play().catch(() => { /* Ignore */ })
		} else {
			elements.audio.pause()
		}
	})
	const openSync = () => {
		elements.syncProgress.hidden = true
		elements.syncDialog.showModal()
	}
	$('open-sync').addEventListener('click', openSync)
	$('empty-sync').addEventListener('click', openSync)
	elements.syncNow.addEventListener('click', () => fullSync())
	$('clear-data').addEventListener('click', async () => {
		if (outboxCount > 0 && !confirm(`${outboxCount} decisions haven't been sent to Bridge yet and will be lost. Continue?`)) { return }
		if (outboxCount === 0 && !confirm('Remove all downloaded songs from this phone?')) { return }
		queue = []
		undoStack = []
		await promisify(store('queue', 'readwrite').clear())
		await promisify(store('outbox', 'readwrite').clear())
		if (mediaCacheAvailable) { await caches.delete(MEDIA_CACHE) }
		await refreshOutboxCount()
		await showCurrent()
	})

	elements.audio.loop = true
	elements.audio.addEventListener('play', () => elements.play.classList.add('playing'))
	elements.audio.addEventListener('pause', () => elements.play.classList.remove('playing'))
	elements.audio.addEventListener('timeupdate', () => {
		const duration = elements.audio.duration || 1
		elements.progressFill.style.width = `${elements.audio.currentTime / duration * 100}%`
	})

	document.addEventListener('keydown', event => {
		if (elements.syncDialog.open) { return }
		switch (event.key) {
			case 'ArrowRight': decide('keep'); break
			case 'ArrowLeft': decide('skip'); break
			case 'ArrowDown': later(); break
			case 'z': case 'Backspace': undo(); break
			case ' ': elements.play.click(); break
			default: return
		}
		event.preventDefault()
	})

	window.addEventListener('online', () => scheduleQuietSync(500))
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') { scheduleQuietSync(500) }
	})
}

// ---------- Startup ----------

async function start() {
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker registration failed', err))
	}
	if (navigator.storage?.persist) {
		navigator.storage.persist().catch(() => { /* Best effort */ })
	}

	db = await openDb()
	queue = (await promisify(store('queue').getAll()) as QueuedSong[]).sort((a, b) => a.order - b.order)
	stats = await getMeta<Stats>('stats')
	const batchSize = await getMeta<number>('batchSize')
	if (batchSize) { elements.batchSize.value = `${batchSize}` }
	await refreshOutboxCount()

	setUpSwipe()
	setUpControls()
	await showCurrent()
	scheduleQuietSync(500)
}

start().catch(err => {
	elements.emptyTitle.textContent = 'Something went wrong'
	elements.emptyBody.textContent = err instanceof Error ? err.message : String(err)
	elements.empty.hidden = false
})
