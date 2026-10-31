/**
 * Bridge Review - Downloads
 * Sends kept songs to Bridge's normal download queue and records the outcome of each download.
 */

import { rankCharts } from '../../../src-shared/ReviewUtils.js'
import { downloadQueue } from '../DownloadHandler.ipc.js'
import { getReviewDb } from './ReviewDatabase.js'

const ALREADY_EXISTS_HEADER = 'This chart already exists in your library folder'

let listening = false

/** Starts tracking download outcomes in the review database. */
export function trackReviewDownloads() {
	if (listening) { return }
	listening = true
	downloadQueue.onOutcome((md5, outcome) => {
		const db = getReviewDb()
		if (outcome.type === 'done' || outcome.error.header === ALREADY_EXISTS_HEADER) {
			db.setDownloadStatusByMd5(md5, 'done')
		} else {
			db.setDownloadStatusByMd5(md5, 'error', `${outcome.error.header}: ${outcome.error.body}`.slice(0, 1000))
		}
	})
}

/**
 * Queues the best chart of every kept song that hasn't been downloaded yet.
 * @returns the number of charts queued.
 */
export function queueKeptDownloads() {
	const db = getReviewDb()
	let queued = 0
	for (const song of db.getSongsToDownload()) {
		const best = rankCharts(db.getChartsForSong(song.songKey))[0]
		if (!best) { continue }

		db.setDownloadStatus(song.songKey, best.md5, 'queued')
		// Same defaults as DownloadService.addDownload in the renderer
		const chart = {
			name: best.name ?? 'Unknown Name',
			artist: best.artist ?? 'Unknown Artist',
			album: best.album ?? 'Unknown Album',
			genre: best.genre ?? 'Unknown Genre',
			year: best.year ?? 'Unknown Year',
			charter: best.charter ?? 'Unknown Charter',
		}
		downloadQueue.retry(best.md5) // Re-runs the download if it previously failed in this session
		downloadQueue.add(best.md5, best.hasVideoBackground, chart)
		queued++
	}
	return queued
}
