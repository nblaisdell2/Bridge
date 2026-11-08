/**
 * Bridge Review - IPC Handlers
 * Wires review mode together: catalog sync, clip buffer, phone server, and kept-song downloads.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import QRCode from 'qrcode'

import {
	ReviewDecision, ReviewProgress, ReviewServerInfo, ReviewSong, ReviewSongFilter, ReviewSongPage, ReviewStats,
} from '../../../src-shared/interfaces/review.interface.js'
import { emitIpcEvent } from '../../main.js'
import { settings } from '../SettingsHandler.ipc.js'
import { cleanUpDecidedClips, ensureClipBuffer, prioritizeArtistClips, stopClipService } from './ClipService.js'
import { getReviewDb } from './ReviewDatabase.js'
import { queueKeptDownloads, trackReviewDownloads } from './ReviewDownloads.js'
import { getReviewServerState, isWebAppBuilt, startReviewServer, stopReviewServer } from './ReviewServer.js'
import { isSyncRunning, markOwnedSongs, syncCatalog } from './ReviewSync.js'

const STARTUP_SYNC_DELAY_MS = 15 * 1000
const AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000
const WINDOWS_TAILSCALE_PATH = 'C:\\Program Files\\Tailscale\\tailscale.exe'

let initialized = false
let autoSyncTimer: NodeJS.Timeout | null = null

const reportProgress = (progress: ReviewProgress) => emitIpcEvent('reviewProgress', progress)

/**
 * Starts review mode's background services. Called once the main window exists.
 */
export function initReview() {
	if (initialized) { return }
	initialized = true
	trackReviewDownloads()
	startReviewServer(settings.reviewServerPort, {
		onDecisions: changed => afterDecisions(changed),
		onNeedClips: readyCount => { ensureClipBuffer(reportProgress, readyCount).catch(logError) },
		onNeedArtistClips: artistKey => { prioritizeArtistClips(reportProgress, artistKey).catch(logError) },
	})

	// Resume clip generation and any kept songs that weren't downloaded before Bridge last closed
	if (getReviewDb().hasSongs()) {
		ensureClipBuffer(reportProgress).catch(logError)
		if (settings.reviewAutoDownload) { queueKeptDownloads() }
	}

	setTimeout(() => {
		if (settings.reviewAutoSync && getReviewDb().hasSongs()) { runSync() }
	}, STARTUP_SYNC_DELAY_MS)
	autoSyncTimer = setInterval(() => {
		if (settings.reviewAutoSync && getReviewDb().hasSongs()) { runSync() }
	}, AUTO_SYNC_INTERVAL_MS)
}

export function shutdownReview() {
	if (autoSyncTimer) { clearInterval(autoSyncTimer) }
	stopClipService()
	stopReviewServer()
}

function runSync() {
	return syncCatalog(reportProgress)
		.then(() => ensureClipBuffer(reportProgress))
		.catch(err => {
			reportProgress({ kind: 'sync', message: 'Sync failed', error: err instanceof Error ? err.message : String(err), finished: true })
			logError(err)
		})
}

function afterDecisions(changed: ReviewSong[]) {
	cleanUpDecidedClips().catch(logError)
	if (settings.reviewAutoDownload && changed.some(s => s.status === 'keep')) {
		const queued = queueKeptDownloads()
		if (queued > 0) { reportProgress({ kind: 'downloads', message: `Queued ${queued} kept song${queued === 1 ? '' : 's'} for download`, finished: true }) }
	}
	ensureClipBuffer(reportProgress).catch(logError)
}

export async function reviewGetStats(): Promise<ReviewStats> {
	return getReviewDb().getStats()
}

export async function reviewSync(): Promise<ReviewStats> {
	if (!isSyncRunning()) { runSync() }
	return getReviewDb().getStats()
}

export async function reviewCheckOwned(): Promise<number> {
	return markOwnedSongs()
}

export async function reviewDownloadKept(): Promise<number> {
	return queueKeptDownloads()
}

export async function reviewListSongs(filter: ReviewSongFilter): Promise<ReviewSongPage> {
	return getReviewDb().listSongs(filter)
}

export async function reviewSetDecision(decision: ReviewDecision): Promise<ReviewSong | null> {
	const changed = getReviewDb().applyDecisions([decision])
	if (changed.length > 0) { afterDecisions(changed) }
	return getReviewDb().getSong(decision.songKey)
}

export async function reviewGetServerInfo(): Promise<ReviewServerInfo> {
	const state = getReviewServerState()
	const port = settings.reviewServerPort
	const dnsName = await getTailscaleDnsName()
	const tailscaleUrl = dnsName ? `https://${dnsName}` : null
	let error = state.error
	if (!error && !(await isWebAppBuilt())) {
		error = 'The phone app has not been built (dist/review-web is missing).'
	}
	return {
		running: state.running,
		port,
		localUrl: `http://127.0.0.1:${port}`,
		tailscaleUrl,
		tailscaleInstalled: getTailscalePath() !== null,
		qrDataUrl: tailscaleUrl ? await QRCode.toDataURL(tailscaleUrl, { margin: 1, width: 240 }) : null,
		error,
	}
}

/** Runs `tailscale serve --bg <port>` so the phone app is reachable over HTTPS on the user's tailnet. */
export async function reviewSetupTailscale(): Promise<{ success: boolean; output: string }> {
	const tailscalePath = getTailscalePath()
	if (!tailscalePath) { return { success: false, output: 'Tailscale is not installed.' } }
	try {
		const output = await runCommand(tailscalePath, ['serve', '--bg', `${settings.reviewServerPort}`], 30000)
		return { success: true, output }
	} catch (err) {
		return { success: false, output: err instanceof Error ? err.message : String(err) }
	}
}

function getTailscalePath() {
	if (process.platform === 'win32' && existsSync(WINDOWS_TAILSCALE_PATH)) { return WINDOWS_TAILSCALE_PATH }
	if (process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) {
		return '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
	}
	for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
		const candidate = `${dir}/${process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'}`
		if (dir && existsSync(candidate)) { return candidate }
	}
	return null
}

async function getTailscaleDnsName() {
	const tailscalePath = getTailscalePath()
	if (!tailscalePath) { return null }
	try {
		const status = JSON.parse(await runCommand(tailscalePath, ['status', '--json'], 10000)) as { Self?: { DNSName?: string } }
		return status.Self?.DNSName?.replace(/\.$/, '') || null
	} catch {
		return null
	}
}

function runCommand(command: string, args: string[], timeout: number) {
	return new Promise<string>((resolve, reject) => {
		execFile(command, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error((stderr || stdout || err.message).trim()))
			} else {
				resolve((stdout || stderr).trim())
			}
		})
	})
}

function logError(err: unknown) {
	console.error('Review:', err)
}
