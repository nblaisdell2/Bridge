/**
 * Bridge Review - Catalog sync
 * Pulls every chart matching the review filter from the Chorus Encore API into the review database.
 * The first sync imports the whole catalog (resumable); later syncs only page through recent charts.
 */

import { ReviewProgress } from '../../../src-shared/interfaces/review.interface.js'
import { SearchResult } from '../../../src-shared/interfaces/search.interface.js'
import { getSongKey } from '../../../src-shared/ReviewUtils.js'
import { getCatalogDb } from '../catalog/CatalogDatabase.js'
import { settings } from '../SettingsHandler.ipc.js'
import { getReviewDb } from './ReviewDatabase.js'

const API_URL = 'https://api.enchor.us/search'
const PAGE_SIZE = 250
const REQUEST_DELAY_MS = 1000
const MAX_RETRIES = 5
/** Incremental syncs keep paging until a whole page is this much older than the newest chart seen last time */
const WATERMARK_SLACK_MS = 24 * 60 * 60 * 1000

export interface SyncResult {
	chartsSeen: number
	songsAdded: number
	songsOwned: number
}

let runningSync: Promise<SyncResult> | null = null

/** Syncs the review database with Chorus. Concurrent calls share the same sync. */
export function syncCatalog(onProgress: (progress: ReviewProgress) => void) {
	if (!runningSync) {
		runningSync = runSync(onProgress).finally(() => runningSync = null)
	}
	return runningSync
}

export function isSyncRunning() {
	return runningSync !== null
}

async function runSync(onProgress: (progress: ReviewProgress) => void): Promise<SyncResult> {
	const db = getReviewDb()
	const filter = `${settings.reviewInstrument}/${settings.reviewDifficulty}`
	if (db.getState('filter') !== filter) {
		// A new filter needs a full import
		db.setState('filter', filter)
		db.setState('initialSyncComplete', '')
		db.setState('initialSyncPage', '1')
	}

	const isInitial = db.getState('initialSyncComplete') !== 'true'
	const watermark = Date.parse(db.getState('newestModifiedTime') ?? '') || 0
	let newestModifiedTime = watermark
	let page = isInitial ? Number(db.getState('initialSyncPage') || 1) : 1
	let totalPages: number | null = null
	const result: SyncResult = { chartsSeen: 0, songsAdded: 0, songsOwned: 0 }

	while (true) {
		onProgress({
			kind: 'sync',
			message: isInitial
				? `Importing the Chorus catalog (page ${page}${totalPages ? ` of ${totalPages}` : ''})...`
				: `Checking for new charts (page ${page})...`,
			done: page - 1,
			total: totalPages ?? undefined,
		})

		const response = await fetchPage(page)
		totalPages = Math.ceil(response.found / PAGE_SIZE)
		const charts = response.data
		result.chartsSeen += charts.length
		result.songsAdded += db.upsertCharts(charts, isInitial)
		for (const chart of charts) {
			newestModifiedTime = Math.max(newestModifiedTime, Date.parse(chart.modifiedTime) || 0)
		}
		if (isInitial) { db.setState('initialSyncPage', `${page + 1}`) }

		const isLastPage = charts.length < PAGE_SIZE || page >= totalPages
		const isPastWatermark = !isInitial && charts.every(c => (Date.parse(c.modifiedTime) || 0) < watermark - WATERMARK_SLACK_MS)
		if (isLastPage || isPastWatermark) { break }

		page++
		await delay(REQUEST_DELAY_MS)
	}

	if (isInitial) { db.setState('initialSyncComplete', 'true') }
	if (newestModifiedTime > 0) { db.setState('newestModifiedTime', new Date(newestModifiedTime).toISOString()) }
	db.setState('lastSyncAt', new Date().toISOString())

	result.songsOwned = markOwnedSongs()
	onProgress({
		kind: 'sync',
		message: `Sync complete: ${result.chartsSeen.toLocaleString()} charts checked, ${result.songsAdded.toLocaleString()} new songs`
			+ (result.songsOwned ? `, ${result.songsOwned.toLocaleString()} already in your library` : ''),
		finished: true,
	})
	return result
}

/** Marks pending songs that are already in the scanned library as owned, so they are never reviewed. */
export function markOwnedSongs() {
	try {
		const ownedKeys = new Set(getCatalogDb().getArtistNamePairs().map(c => getSongKey(c.artist, c.name)))
		return getReviewDb().markOwned(ownedKeys)
	} catch (err) {
		console.error('Review: failed to check library for owned songs', err)
		return 0
	}
}

async function fetchPage(page: number, attempt = 1): Promise<SearchResult> {
	try {
		const response = await fetch(API_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				search: '*',
				per_page: PAGE_SIZE,
				page,
				instrument: settings.reviewInstrument,
				difficulty: settings.reviewDifficulty,
				drumType: null,
				drumsReviewed: false,
				sort: null, // Default order is most recently added first
				source: 'bridge',
			}),
			signal: AbortSignal.timeout(30000),
		})
		if (!response.ok) { throw new Error(`Chorus API returned HTTP ${response.status}`) }
		return await response.json() as SearchResult
	} catch (err) {
		if (attempt >= MAX_RETRIES) { throw err }
		await delay(2000 * attempt)
		return fetchPage(page, attempt + 1)
	}
}

function delay(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}
