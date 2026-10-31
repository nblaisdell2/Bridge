/**
 * Bridge Review - shared types
 * Review mode groups Chorus Encore charts into songs, generates a short preview clip per song,
 * and lets the user mark each song as keep/skip (from the Review tab or the phone app).
 */

export type ReviewStatus = 'pending' | 'keep' | 'skip' | 'owned'
export type ReviewClipStatus = 'none' | 'ready' | 'failed'
export type ReviewDownloadStatus = 'queued' | 'done' | 'error'

export interface ReviewSong {
	songKey: string
	artist: string
	name: string
	album: string
	genre: string
	year: string
	songLength: number | null   // Milliseconds
	albumArtMd5: string | null
	chartCount: number
	charters: string            // Comma-separated, most preferred chart first
	bestMd5: string | null      // Top-ranked chart (see `rankCharts`)
	status: ReviewStatus
	decidedAt: string | null
	clipStatus: ReviewClipStatus
	clipMd5: string | null      // Chart the clip was generated from
	clipError: string | null
	downloadMd5: string | null
	downloadStatus: ReviewDownloadStatus | null
	downloadError: string | null
	firstSeen: string
}

/** A keep/skip decision made by the user. 'pending' undoes an earlier decision. */
export interface ReviewDecision {
	songKey: string
	status: 'keep' | 'skip' | 'pending'
	decidedAt: string // ISO timestamp; the newest decision for a song wins
}

export interface ReviewStats {
	total: number
	pending: number
	keep: number
	skip: number
	owned: number
	clipsReady: number
	clipsFailed: number
	downloadQueued: number
	downloaded: number
	downloadFailed: number
	lastSyncAt: string | null
}

export interface ReviewProgress {
	kind: 'sync' | 'clips' | 'downloads'
	message: string
	done?: number
	total?: number
	finished?: boolean
	error?: string
}

export interface ReviewServerInfo {
	running: boolean
	port: number
	localUrl: string
	tailscaleUrl: string | null    // https://<machine>.<tailnet>.ts.net when Tailscale is installed
	tailscaleInstalled: boolean
	qrDataUrl: string | null       // QR code of `tailscaleUrl`
	error: string | null
}

export interface ReviewSongFilter {
	status: ReviewStatus | 'all'
	search: string
	limit: number
	offset: number
}

export interface ReviewSongPage {
	songs: ReviewSong[]
	total: number
}

/** A song as sent to the phone app in a batch. */
export interface ReviewBatchSong {
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

export interface ReviewBatchResponse {
	songs: ReviewBatchSong[]
	stats: ReviewStats
}
