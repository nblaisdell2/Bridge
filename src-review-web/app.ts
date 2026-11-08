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
	artistKeys?: string[] // Missing on songs downloaded before artist mode existed
}

interface QueuedSong extends BatchSong {
	order: number
}

interface Artist {
	key: string
	name: string
	keptCount: number
	pendingCount: number
}

interface BatchResponse {
	songs: BatchSong[]
	stats: Stats
	artistPending?: number
}

type ReviewMode = 'random' | 'artist'
type QueueName = 'queue' | 'artistQueue'
/** Why the selected artist has no song to show */
type ArtistNotice = 'loading' | 'preparing' | 'offline'

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
const ARTIST_BATCH_SIZE = 1000
const ARTIST_POLL_MS = 4000

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
	emptySync: $<HTMLButtonElement>('empty-sync'),
	emptyArtists: $<HTMLButtonElement>('empty-artists'),
	modeRandom: $<HTMLButtonElement>('mode-random'),
	modeArtist: $<HTMLButtonElement>('mode-artist'),
	modeArtistLabel: $<HTMLElement>('mode-artist-label'),
	artistPicker: $<HTMLElement>('artist-picker'),
	artistSearch: $<HTMLInputElement>('artist-search'),
	artistHint: $<HTMLElement>('artist-hint'),
	artistList: $<HTMLElement>('artist-list'),
	actions: $<HTMLElement>('actions'),
	offlineCount: $<HTMLElement>('offline-count'),
	serverCount: $<HTMLElement>('server-count'),
	outboxBadge: $<HTMLElement>('outbox-badge'),
	undo: $<HTMLButtonElement>('undo'),
	keep: $<HTMLButtonElement>('keep'),
	skip: $<HTMLButtonElement>('skip'),
	later: $<HTMLButtonElement>('later'),
	toast: $<HTMLElement>('toast'),
	toastText: $<HTMLElement>('toast-text'),
	toastUndo: $<HTMLButtonElement>('toast-undo'),
	syncDialog: $<HTMLDialogElement>('sync-dialog'),
	syncStatus: $<HTMLElement>('sync-status'),
	syncProgress: $<HTMLElement>('sync-progress'),
	syncProgressFill: $<HTMLElement>('sync-progress-fill'),
	syncNow: $<HTMLButtonElement>('sync-now'),
	batchSize: $<HTMLSelectElement>('batch-size'),
	audio: $<HTMLAudioElement>('audio'),
}

let db: IDBDatabase
/** The random queue */
let queue: QueuedSong[] = []
/** Songs downloaded for artist mode, for any artist */
let artistQueue: QueuedSong[] = []
/** `artist` is who was being reviewed when the decision was made (null in random mode) */
let undoStack: Array<{ song: QueuedSong; status: Decision['status']; artist: Artist | null }> = []
let outboxCount = 0
let stats: Stats | null = null
let currentObjectUrls: string[] = []
let syncing = false
let toastTimer: number | undefined
let quietSyncTimer: number | undefined

let mode: ReviewMode = 'random'
let selectedArtist: Artist | null = null
/** Artists that can be chosen, as of the last time Bridge was reached */
let artists: Artist[] = []
let pickerOpen = false
let artistsReachable = true
let artistNotice: ArtistNotice | null = null
/** The artist whose songs are currently being requested from Bridge */
let artistRequest: string | null = null
let artistPollTimer: number | undefined
/** The song loaded in the player */
let shownSong: QueuedSong | null = null

// ---------- IndexedDB ----------

function openDb() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 2)
		request.onupgradeneeded = event => {
			const database = request.result
			if (event.oldVersion < 1) {
				database.createObjectStore('queue', { keyPath: 'songKey' })
				database.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
				database.createObjectStore('meta', { keyPath: 'key' })
			}
			if (event.oldVersion < 2) {
				database.createObjectStore('artistQueue', { keyPath: 'songKey' })
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

function store(name: QueueName | 'outbox' | 'meta', mode: IDBTransactionMode = 'readonly') {
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
	const stored = storedSongs()
	if (!stored.some(s => s.clipUrl === song.clipUrl)) { await cache.delete(song.clipUrl) }
	// Album art is shared between songs of the same album, so only delete it when unused
	if (song.artUrl && !stored.some(s => s.artUrl === song.artUrl)) {
		await cache.delete(song.artUrl)
	}
}

/** Removes cached media that no queued (or undoable) song refers to. */
async function pruneMedia() {
	if (!mediaCacheAvailable) { return }
	const cache = await caches.open(MEDIA_CACHE)
	const keep = new Set<string>()
	for (const song of storedSongs()) {
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

async function getJson<T>(url: string): Promise<T> {
	const response = await fetchWithTimeout(url, { method: 'GET' })
	if (!response.ok) { throw new Error(`HTTP ${response.status}`) }
	return await response.json() as T
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
		cachedKeys: [...new Set([...queue, ...artistQueue].map(s => s.songKey))],
	})

	const outboxStore = store('outbox', 'readwrite')
	for (const entry of outbox) { outboxStore.delete(entry.id!) }
	await refreshOutboxCount()

	if (result.removedKeys.length > 0) {
		const removed = new Set(result.removedKeys)
		const removedSongs = [...queue, ...artistQueue].filter(s => removed.has(s.songKey))
		await removeFromQueues(removed)
		for (const song of removedSongs) { await deleteMedia(song) }
		if (shownSong && removed.has(shownSong.songKey)) { await showCurrent() }
	}

	await saveStats(result.stats)
	render()
}

async function saveStats(newStats: Stats) {
	stats = { ...newStats, lastSyncAt: new Date().toISOString() }
	await setMeta('stats', stats)
}

/** Downloads songs until `targetCount` are stored on the device. */
async function downloadSongs(targetCount: number, onProgress?: (done: number, total: number) => void) {
	const needed = targetCount - queue.length
	if (needed <= 0) { return { added: 0, requested: 0 } }

	const batch = await postJson<BatchResponse>('api/batch', {
		count: needed,
		exclude: queue.map(s => s.songKey),
	})
	await saveStats(batch.stats)
	const added = await storeSongs(batch.songs, 'queue', onProgress)
	return { added, requested: needed }
}

/** Downloads the media of `songs` and adds them to the end of a queue. */
async function storeSongs(songs: BatchSong[], queueName: QueueName, onProgress?: (done: number, total: number) => void) {
	let done = 0
	let added = 0
	let next = 0
	await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
		while (next < songs.length) {
			const song = songs[next++]
			try {
				await cacheMedia(song.clipUrl)
				if (song.artUrl) { await cacheMedia(song.artUrl).catch(() => song.artUrl = null) }
				if (!queueOf(queueName).some(s => s.songKey === song.songKey)) {
					const queued: QueuedSong = { ...song, order: maxOrder(queueOf(queueName)) + 1 }
					queueOf(queueName).push(queued)
					await promisify(store(queueName, 'readwrite').put(queued))
					added++
				}
			} catch (err) {
				console.warn('Failed to download', song.name, err)
			}
			onProgress?.(++done, songs.length)
			if (!shownSong && currentSong()) { await showCurrent() }
			render()
		}
	}))
	return added
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
		await fetchArtists()
		if (mode === 'artist') { refreshArtistQueue() }
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
			if (!pickerOpen) { await fetchArtists() } // Not while it would change the list under the user's finger
			if (artistNotice === 'offline') { refreshArtistQueue() }
		} catch {
			// Offline; decisions stay in the outbox
		} finally {
			syncing = false
			render()
		}
	}, delay)
}

// ---------- Review ----------

function queueOf(name: QueueName) {
	return name === 'artistQueue' ? artistQueue : queue
}

function activeQueueName(): QueueName {
	return mode === 'artist' ? 'artistQueue' : 'queue'
}

function artistSongs(artistKey: string) {
	return artistQueue.filter(s => s.artistKeys?.includes(artistKey))
}

/** @returns the songs being reviewed right now, in order. */
function activeSongs() {
	if (mode === 'random') { return queue }
	return selectedArtist ? artistSongs(selectedArtist.key) : []
}

function currentSong(): QueuedSong | undefined {
	return pickerOpen ? undefined : activeSongs()[0]
}

/** @returns every song on the device, including decided ones that can still be undone. */
function storedSongs() {
	return [...queue, ...artistQueue, ...undoStack.map(u => u.song)]
}

function maxOrder(songs: QueuedSong[]) {
	return songs.reduce((max, s) => Math.max(max, s.order), 0)
}

function minOrder(songs: QueuedSong[]) {
	return songs.reduce((min, s) => Math.min(min, s.order), 0)
}

async function removeFromQueues(songKeys: Set<string>) {
	queue = queue.filter(s => !songKeys.has(s.songKey))
	artistQueue = artistQueue.filter(s => !songKeys.has(s.songKey))
	const transaction = db.transaction(['queue', 'artistQueue'], 'readwrite')
	for (const key of songKeys) {
		transaction.objectStore('queue').delete(key)
		transaction.objectStore('artistQueue').delete(key)
	}
	await new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve()
		transaction.onerror = () => reject(transaction.error)
	})
}

async function showCurrent() {
	const song = currentSong()
	shownSong = song ?? null
	currentObjectUrls.forEach(u => URL.revokeObjectURL(u))
	currentObjectUrls = []
	elements.audio.pause()
	elements.card.style.transform = ''
	elements.card.style.opacity = '1'
	resetSwipeLabels()

	if (!song) {
		elements.audio.removeAttribute('src')
		render()
		// Bridge knows whether the artist has more songs or is finished
		if (mode === 'artist' && selectedArtist && !pickerOpen) { refreshArtistQueue() }
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
	const song = currentSong()
	if (!song) { return }

	const decision: Decision = { songKey: song.songKey, status, decidedAt: new Date().toISOString() }
	await promisify(store('outbox', 'readwrite').add(decision))
	await removeFromQueues(new Set([song.songKey])) // A song can be in both queues

	undoStack.push({ song, status, artist: mode === 'artist' ? selectedArtist : null })
	if (undoStack.length > UNDO_LIMIT) {
		const evicted = undoStack.shift()!
		await deleteMedia(evicted.song)
	}

	updateArtistCounts(song, -1, status === 'keep' ? 1 : 0)
	await refreshOutboxCount()
	showToast(`${status === 'keep' ? 'Kept' : 'Skipped'} “${song.name}”`)
	await animateOut(status === 'keep' ? 1 : -1)
	await showCurrent()
	scheduleQuietSync()
}

async function later() {
	const song = currentSong()
	if (!song) { return }
	const name = activeQueueName()
	queueOf(name).splice(queueOf(name).indexOf(song), 1)
	song.order = maxOrder(queueOf(name)) + 1
	queueOf(name).push(song)
	await promisify(store(name, 'readwrite').put(song))
	await animateOut(0)
	await showCurrent()
}

async function undo() {
	const last = undoStack.pop()
	if (!last) { return }
	const decision: Decision = { songKey: last.song.songKey, status: 'pending', decidedAt: new Date().toISOString() }
	await promisify(store('outbox', 'readwrite').add(decision))

	const name: QueueName = last.artist ? 'artistQueue' : 'queue'
	last.song.order = minOrder(queueOf(name)) - 1
	queueOf(name).unshift(last.song)
	await promisify(store(name, 'readwrite').put(last.song))

	// Go back to where the decision was made, which brings back an artist if that decision finished them
	mode = last.artist ? 'artist' : 'random'
	if (last.artist) { selectedArtist = last.artist }
	pickerOpen = false
	artistNotice = null
	updateArtistCounts(last.song, 1, last.status === 'keep' ? -1 : 0)
	await saveModeState()

	await refreshOutboxCount()
	hideToast()
	await showCurrent()
	scheduleQuietSync()
}

// ---------- Artist mode ----------

function saveModeState() {
	return Promise.all([setMeta('mode', mode), setMeta('selectedArtist', selectedArtist)])
}

/** Keeps the artist list correct between syncs with Bridge, so that it's still right when offline. */
function updateArtistCounts(song: QueuedSong, pendingChange: number, keptChange: number) {
	for (const artist of new Set([...artists, ...(selectedArtist ? [selectedArtist] : [])])) {
		if (song.artistKeys?.includes(artist.key)) {
			artist.pendingCount = Math.max(0, artist.pendingCount + pendingChange)
			artist.keptCount = Math.max(0, artist.keptCount + keptChange)
		}
	}
	setMeta('artists', artists).catch(() => { /* Best effort */ })
}

async function fetchArtists() {
	const result = await getJson<{ artists: Artist[]; stats: Stats }>('api/artists')
	artists = result.artists
	await setMeta('artists', artists)
	const updatedSelection = artists.find(a => a.key === selectedArtist?.key)
	if (updatedSelection) {
		selectedArtist = updatedSelection
		await setMeta('selectedArtist', selectedArtist)
	}
}

/** @param messageIfNoArtists Shown when it turns out there are no artists to choose from, returning to random. */
async function openPicker(messageIfNoArtists = 'Keep a song and its artists will show up here.') {
	pickerOpen = true
	elements.artistSearch.value = ''
	await showCurrent()
	renderArtists()

	// Send decisions first so that a song kept moments ago counts
	try {
		await syncDecisions()
		await fetchArtists()
		artistsReachable = true
	} catch {
		artistsReachable = false
	}
	if (!pickerOpen) { return }

	if (artistsReachable && artists.length === 0) {
		await switchToRandom()
		showToast(messageIfNoArtists, undoStack.length > 0)
	} else {
		renderArtists()
	}
}

async function closePicker() {
	pickerOpen = false
	if (mode === 'artist' && !selectedArtist) {
		mode = 'random'
		await saveModeState()
	}
	await showCurrent()
}

async function switchToRandom() {
	if (mode === 'random' && !pickerOpen) { return }
	clearTimeout(artistPollTimer)
	mode = 'random'
	pickerOpen = false
	artistNotice = null
	await saveModeState()
	await showCurrent()
}

async function onArtistButton() {
	if (pickerOpen) {
		await closePicker()
	} else if (mode === 'random' && selectedArtist) {
		await selectArtist(selectedArtist) // Pick up where they left off; pressing it again changes artist
	} else {
		await openPicker()
	}
}

async function selectArtist(artist: Artist) {
	selectedArtist = artist
	mode = 'artist'
	pickerOpen = false
	artistNotice = null
	await saveModeState()
	await showCurrent()
	refreshArtistQueue()
}

/**
 * Downloads the selected artist's songs. Bridge makes their clips on demand, so this repeats while more are on the way.
 * If Bridge has no more of their songs to review and none are left on the device, the artist is finished.
 */
async function refreshArtistQueue() {
	clearTimeout(artistPollTimer)
	const artist = selectedArtist
	if (mode !== 'artist' || !artist || artistRequest === artist.key) { return }

	artistRequest = artist.key
	if (!currentSong()) {
		artistNotice = 'loading'
		render()
	}
	try {
		await syncDecisions()
		const batch = await postJson<BatchResponse>('api/batch', {
			artist: artist.key,
			count: ARTIST_BATCH_SIZE,
			exclude: artistSongs(artist.key).map(s => s.songKey),
		})
		await saveStats(batch.stats)
		await storeSongs(batch.songs, 'artistQueue')
		if (selectedArtist?.key !== artist.key || mode !== 'artist') { return }

		const pending = batch.artistPending ?? 0
		const onDevice = artistSongs(artist.key).length
		selectedArtist.pendingCount = pending
		artistNotice = pending > onDevice ? 'preparing' : null
		if (artistNotice === 'preparing') {
			artistPollTimer = window.setTimeout(() => refreshArtistQueue(), ARTIST_POLL_MS)
		} else if (onDevice === 0) {
			await finishArtist(artist)
		}
	} catch {
		if (selectedArtist?.key === artist.key) { artistNotice = 'offline' }
	} finally {
		if (artistRequest === artist.key) { artistRequest = null }
		render()
	}
}

async function finishArtist(artist: Artist) {
	selectedArtist = null
	artistNotice = null
	await saveModeState()
	showToast(`Finished ${artist.name}`)
	await openPicker('That was the last of the artists you liked, so you’re back to random.')
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
	const readyCount = activeSongs().length
	const hasSong = currentSong() !== undefined
	elements.card.hidden = !hasSong
	elements.artistPicker.hidden = !pickerOpen
	elements.empty.hidden = hasSong || pickerOpen
	elements.actions.hidden = pickerOpen
	elements.keep.disabled = elements.skip.disabled = elements.later.disabled = !hasSong
	elements.undo.disabled = undoStack.length === 0
	elements.modeRandom.classList.toggle('active', mode === 'random' && !pickerOpen)
	elements.modeArtist.classList.toggle('active', mode === 'artist' || pickerOpen)
	elements.modeArtistLabel.textContent = selectedArtist?.name ?? 'Artists'
	elements.offlineCount.textContent = `${readyCount.toLocaleString()} song${readyCount === 1 ? '' : 's'} ready`
	elements.outboxBadge.hidden = outboxCount === 0
	elements.outboxBadge.textContent = `${outboxCount}`

	if (stats) {
		const remaining = mode === 'artist' && selectedArtist
			? `${selectedArtist.pendingCount.toLocaleString()} left by this artist`
			: `${stats.pending.toLocaleString()} left to review`
		elements.serverCount.textContent = `${remaining} · ${stats.keep.toLocaleString()} kept`
			+ (stats.lastSyncAt ? ` · synced ${timeAgo(stats.lastSyncAt)}` : '')
	}

	if (!hasSong) { renderEmptyState() }
}

function renderEmptyState() {
	const artist = mode === 'artist' ? selectedArtist : null
	elements.emptyArtists.hidden = !artist
	elements.emptySync.hidden = artist !== null && artistNotice !== 'offline'

	if (artist) {
		const isOffline = artistNotice === 'offline'
		elements.emptyTitle.textContent = isOffline ? `No more ${artist.name} songs on this device` : `Getting ${artist.name} ready`
		elements.emptyBody.textContent = isOffline
			? 'Connect to your PC (through Tailscale) to download more of their songs, or choose another artist.'
			: artistNotice === 'preparing'
				? 'Bridge is making preview clips for this artist. The first one will start as soon as it’s ready.'
				: 'Checking Bridge for songs by this artist.'
		return
	}

	const allDone = stats !== null && stats.pending === 0
	elements.emptyTitle.textContent = allDone ? 'All caught up!' : 'No songs on this device'
	elements.emptyBody.textContent = allDone
		? 'Every song has been reviewed. New charts appear here after Bridge syncs with Chorus.'
		: 'Connect to your PC (through Tailscale) and download a batch of songs to review.'
}

function renderArtists() {
	const search = elements.artistSearch.value.trim().toLowerCase()
	const available = artists.filter(a => a.pendingCount > 0)
	const visible = available.filter(a => a.name.toLowerCase().includes(search))
	elements.artistList.replaceChildren(...visible.map(createArtistRow))

	const hint = !artistsReachable
		? (available.length > 0 ? 'Can’t reach Bridge, so this is your last synced list. Only downloaded songs will play.' : 'Connect to Bridge to load your artists.')
		: visible.length === 0 && available.length > 0 ? 'No artists match your search.' : ''
	elements.artistHint.textContent = hint
	elements.artistHint.hidden = !hint
}

function createArtistRow(artist: Artist) {
	const row = document.createElement('button')
	row.type = 'button'
	row.className = 'artist-row'
	row.classList.toggle('current', artist.key === selectedArtist?.key)

	const name = document.createElement('span')
	name.className = 'artist-name'
	name.textContent = artist.name

	const downloaded = artistSongs(artist.key).length
	const details = document.createElement('span')
	details.className = 'artist-details'
	details.textContent = `${artist.pendingCount.toLocaleString()} to review · ${artist.keptCount.toLocaleString()} kept`
		+ (downloaded > 0 ? ` · ${downloaded.toLocaleString()} downloaded` : '')

	row.append(name, details)
	row.addEventListener('click', () => selectArtist(artist))
	return row
}

function showToast(text: string, canUndo = true) {
	elements.toastText.textContent = text
	elements.toastUndo.hidden = !canUndo
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
	elements.toastUndo.addEventListener('click', () => undo())
	elements.modeRandom.addEventListener('click', () => switchToRandom())
	elements.modeArtist.addEventListener('click', () => onArtistButton())
	elements.emptyArtists.addEventListener('click', () => openPicker())
	elements.artistSearch.addEventListener('input', () => renderArtists())
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
	elements.emptySync.addEventListener('click', openSync)
	elements.syncNow.addEventListener('click', () => fullSync())
	$('clear-data').addEventListener('click', async () => {
		if (outboxCount > 0 && !confirm(`${outboxCount} decisions haven't been sent to Bridge yet and will be lost. Continue?`)) { return }
		if (outboxCount === 0 && !confirm('Remove all downloaded songs from this phone?')) { return }
		queue = []
		artistQueue = []
		undoStack = []
		await promisify(store('queue', 'readwrite').clear())
		await promisify(store('artistQueue', 'readwrite').clear())
		await promisify(store('outbox', 'readwrite').clear())
		if (mediaCacheAvailable) { await caches.delete(MEDIA_CACHE) }
		await refreshOutboxCount()

		// Otherwise artist mode would immediately download the songs again
		clearTimeout(artistPollTimer)
		mode = 'random'
		selectedArtist = null
		pickerOpen = false
		artistNotice = null
		await saveModeState()
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
		if (pickerOpen) {
			if (event.key === 'Escape') { closePicker() }
			return
		}
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
	artistQueue = (await promisify(store('artistQueue').getAll()) as QueuedSong[]).sort((a, b) => a.order - b.order)
	stats = await getMeta<Stats>('stats')
	artists = await getMeta<Artist[]>('artists') ?? []
	selectedArtist = await getMeta<Artist>('selectedArtist')
	mode = selectedArtist ? await getMeta<ReviewMode>('mode') ?? 'random' : 'random'
	const batchSize = await getMeta<number>('batchSize')
	if (batchSize) { elements.batchSize.value = `${batchSize}` }
	await refreshOutboxCount()

	setUpSwipe()
	setUpControls()
	await showCurrent()
	if (mode === 'artist') { refreshArtistQueue() }
	scheduleQuietSync(500)
}

start().catch(err => {
	elements.emptyTitle.textContent = 'Something went wrong'
	elements.emptyBody.textContent = err instanceof Error ? err.message : String(err)
	elements.empty.hidden = false
})
