/**
 * Bridge Review - Clip service
 * Keeps a rolling buffer of preview clips ready for the next songs in the review queue,
 * and deletes clips once their song has been decided.
 */

import { app } from 'electron'
import ffmpegStaticPath from 'ffmpeg-static'
import { ensureDir, pathExists, remove } from 'fs-extra'
import * as path from 'path'

import { ReviewProgress } from '../../../src-shared/interfaces/review.interface.js'
import { dataPath } from '../../../src-shared/Paths.js'
import { settings } from '../SettingsHandler.ipc.js'
import { extractClip } from './ClipExtractor.js'
import { getReviewDb } from './ReviewDatabase.js'

export const clipsPath = path.join(dataPath, 'review-clips')

const CLIP_CONCURRENCY = 2
const MAX_CLIP_ATTEMPTS = 2
const DELAY_BETWEEN_CLIPS_MS = 250
const PROGRESS_INTERVAL_MS = 1000

let runningBuffer: Promise<void> | null = null
let requestedReadyCount = 0
/** The artist being reviewed in artist mode, whose clips are made before the regular buffer */
let priorityArtist: string | null = null
let abortController = new AbortController()

/** @returns the path to the bundled ffmpeg binary (unpacked from the asar archive in production). */
export function getFfmpegPath() {
	const ffmpegPath = (ffmpegStaticPath as unknown as string | null) ?? 'ffmpeg'
	return app.isPackaged ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath
}

export function getClipFilePath(md5: string) {
	return path.join(clipsPath, `${md5}.mp3`)
}

/**
 * Generates clips until at least `readyCount` pending songs have one (default: the configured buffer size).
 * Concurrent calls share the same worker; a larger `readyCount` raises its target.
 */
export function ensureClipBuffer(onProgress: (progress: ReviewProgress) => void, readyCount = settings.reviewClipBuffer) {
	requestedReadyCount = Math.max(requestedReadyCount, readyCount)
	if (!runningBuffer) {
		runningBuffer = fillBuffer(onProgress).finally(() => {
			runningBuffer = null
			requestedReadyCount = 0
			priorityArtist = null
		})
	}
	return runningBuffer
}

/** Makes clips for all of an artist's pending songs, ahead of the regular buffer. Replaces any previous priority artist. */
export function prioritizeArtistClips(onProgress: (progress: ReviewProgress) => void, artistKey: string) {
	priorityArtist = artistKey
	return ensureClipBuffer(onProgress)
}

/** Stops clip generation (used when Bridge quits). */
export function stopClipService() {
	abortController.abort()
	abortController = new AbortController()
}

async function fillBuffer(onProgress: (progress: ReviewProgress) => void) {
	const db = getReviewDb()
	await ensureDir(clipsPath)

	let lastProgressAt = 0
	let generated = 0
	const reportProgress = (force = false) => {
		if (!force && Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) { return }
		lastProgressAt = Date.now()
		if (priorityArtist) {
			const { pending, ready } = db.getArtistQueueCounts(priorityArtist)
			onProgress({ kind: 'clips', message: `Preparing clips for the artist you're reviewing (${ready} of ${pending} ready)`, done: ready, total: pending })
			return
		}
		const ready = db.countReadyClips()
		onProgress({
			kind: 'clips',
			message: `Preparing preview clips (${ready.toLocaleString()} of ${requestedReadyCount.toLocaleString()} ready)`,
			done: ready,
			total: requestedReadyCount,
		})
	}

	const getNextSongs = () => {
		if (priorityArtist) {
			const artistSongs = db.getArtistSongsNeedingClips(priorityArtist, 20, MAX_CLIP_ATTEMPTS)
			if (artistSongs.length > 0) { return artistSongs }
			priorityArtist = null
		}
		const missing = requestedReadyCount - db.countReadyClips()
		return missing > 0 ? db.getSongsNeedingClips(Math.min(missing, 20), MAX_CLIP_ATTEMPTS) : []
	}

	const signal = abortController.signal
	while (!signal.aborted) {
		const songs = getNextSongs()
		if (songs.length === 0) { break }

		// A newly selected artist shouldn't have to wait for the rest of this group of clips
		const songsArtist = priorityArtist
		let next = 0
		await Promise.all(Array.from({ length: CLIP_CONCURRENCY }, async () => {
			while (next < songs.length && !signal.aborted && priorityArtist === songsArtist) {
				const song = songs[next++]
				const chart = song.bestMd5 ? db.getChart(song.bestMd5) : null
				if (!chart) {
					db.setClipFailed(song.songKey, 'Chart data missing', MAX_CLIP_ATTEMPTS)
					continue
				}
				try {
					await extractClip({
						md5: chart.md5,
						hasVideoBackground: chart.hasVideoBackground,
						previewStartMs: chart.preview_start_time,
						songLengthMs: chart.song_length,
						clipSeconds: settings.reviewClipSeconds,
						outputPath: getClipFilePath(chart.md5),
						ffmpegPath: getFfmpegPath(),
						signal,
					})
					db.setClipReady(song.songKey, chart.md5)
					generated++
				} catch (err) {
					if (signal.aborted) { return }
					const message = err instanceof Error ? err.message : String(err)
					console.warn(`Review: clip failed for "${song.artist} - ${song.name}" (${chart.md5}): ${message}`)
					db.setClipFailed(song.songKey, message, MAX_CLIP_ATTEMPTS)
				}
				reportProgress()
				await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CLIPS_MS))
			}
		}))
	}

	if (generated > 0 || !signal.aborted) { reportProgress(true) }
}

/** Deletes the clips of songs that are no longer pending. */
export async function cleanUpDecidedClips() {
	const db = getReviewDb()
	for (const { songKey, clipMd5 } of db.getDecidedSongsWithClips()) {
		db.clearClip(songKey)
		if (clipMd5) {
			const clipPath = getClipFilePath(clipMd5)
			if (await pathExists(clipPath)) { await remove(clipPath) }
		}
	}
}
