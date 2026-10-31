/**
 * Bridge Review - Database Service
 * Stores Chorus charts grouped into songs, the user's keep/skip decisions,
 * and the state of each song's preview clip and download.
 */

import Database from 'better-sqlite3'
import * as path from 'path'

import {
	ReviewDecision, ReviewDownloadStatus, ReviewSong, ReviewSongFilter, ReviewSongPage, ReviewStats,
} from '../../../src-shared/interfaces/review.interface.js'
import { ChartData } from '../../../src-shared/interfaces/search.interface.js'
import { dataPath } from '../../../src-shared/Paths.js'
import { getSongKey, rankCharts } from '../../../src-shared/ReviewUtils.js'

class ReviewDatabase {
	private db: Database.Database

	constructor() {
		this.db = new Database(path.join(dataPath, 'review.db'))
		this.db.pragma('journal_mode = WAL')
		this.initializeSchema()
	}

	private initializeSchema(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS songs (
        song_key TEXT PRIMARY KEY,
        artist TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        album TEXT DEFAULT '',
        genre TEXT DEFAULT '',
        year TEXT DEFAULT '',
        song_length INTEGER,
        album_art_md5 TEXT,
        chart_count INTEGER NOT NULL DEFAULT 0,
        charters TEXT DEFAULT '',
        best_md5 TEXT,

        -- Review order: random for the initial backlog, negative (newest first) for later arrivals
        queue_order REAL NOT NULL,

        status TEXT NOT NULL DEFAULT 'pending',
        decided_at TEXT,

        clip_md5 TEXT,
        clip_status TEXT NOT NULL DEFAULT 'none',
        clip_error TEXT,
        clip_attempts INTEGER NOT NULL DEFAULT 0,

        download_md5 TEXT,
        download_status TEXT,
        download_error TEXT,

        first_seen TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_songs_queue ON songs(status, clip_status, queue_order);

      CREATE TABLE IF NOT EXISTS charts (
        md5 TEXT PRIMARY KEY,
        song_key TEXT NOT NULL,
        chart_id INTEGER,
        charter TEXT,
        modified_time TEXT,
        has_video INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_charts_song ON charts(song_key);

      CREATE TABLE IF NOT EXISTS review_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `)
	}

	getState(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM review_state WHERE key = ?').get(key) as { value: string } | undefined
		return row?.value ?? null
	}

	setState(key: string, value: string): void {
		this.db.prepare('INSERT OR REPLACE INTO review_state (key, value) VALUES (?, ?)').run(key, value)
	}

	hasSongs(): boolean {
		return this.db.prepare('SELECT 1 FROM songs LIMIT 1').get() !== undefined
	}

	/**
	 * Inserts or updates `charts` and refreshes the songs they belong to.
	 * @param isBacklog If new songs are part of the initial import (shuffled) rather than new arrivals (shown first).
	 * @returns the number of songs that were created.
	 */
	upsertCharts(charts: ChartData[], isBacklog: boolean): number {
		const upsertChart = this.db.prepare(`
      INSERT INTO charts (md5, song_key, chart_id, charter, modified_time, has_video, data_json)
      VALUES (@md5, @songKey, @chartId, @charter, @modifiedTime, @hasVideo, @dataJson)
      ON CONFLICT(md5) DO UPDATE SET
        song_key = excluded.song_key, chart_id = excluded.chart_id, charter = excluded.charter,
        modified_time = excluded.modified_time, has_video = excluded.has_video, data_json = excluded.data_json
    `)

		let createdCount = 0
		const run = this.db.transaction(() => {
			const touchedSongs = new Set<string>()
			for (const chart of charts) {
				const songKey = getSongKey(chart.artist, chart.name)
				touchedSongs.add(songKey)
				upsertChart.run({
					md5: chart.md5,
					songKey,
					chartId: chart.chartId,
					charter: chart.charter ?? '',
					modifiedTime: chart.modifiedTime,
					hasVideo: chart.hasVideoBackground ? 1 : 0,
					dataJson: JSON.stringify(chart),
				})
			}
			for (const songKey of touchedSongs) {
				if (this.refreshSong(songKey, isBacklog)) { createdCount++ }
			}
		})
		run()
		return createdCount
	}

	/**
	 * Recomputes a song's metadata from its charts.
	 * @returns `true` if the song was created.
	 */
	private refreshSong(songKey: string, isBacklog: boolean): boolean {
		const charts = rankCharts(this.getChartsForSong(songKey))
		if (charts.length === 0) { return false }
		const best = charts[0]
		const existing = this.db.prepare('SELECT song_key FROM songs WHERE song_key = ?').get(songKey)

		const values = {
			songKey,
			artist: best.artist ?? '',
			name: best.name ?? '',
			album: best.album ?? '',
			genre: best.genre ?? '',
			year: best.year ?? '',
			songLength: best.song_length,
			albumArtMd5: best.albumArtMd5 ?? null,
			chartCount: charts.length,
			charters: [...new Set(charts.map(c => (c.charter ?? '').replace(/<[^>]*>/g, '').trim()).filter(c => c))].join(', '),
			bestMd5: best.md5,
		}

		if (existing) {
			this.db.prepare(`
        UPDATE songs SET artist = @artist, name = @name, album = @album, genre = @genre, year = @year,
          song_length = @songLength, album_art_md5 = @albumArtMd5, chart_count = @chartCount,
          charters = @charters, best_md5 = @bestMd5
        WHERE song_key = @songKey
      `).run(values)
			return false
		}

		this.db.prepare(`
      INSERT INTO songs (song_key, artist, name, album, genre, year, song_length, album_art_md5, chart_count,
        charters, best_md5, queue_order, first_seen)
      VALUES (@songKey, @artist, @name, @album, @genre, @year, @songLength, @albumArtMd5, @chartCount,
        @charters, @bestMd5, @queueOrder, @firstSeen)
    `).run({
			...values,
			queueOrder: isBacklog ? Math.random() : -(Date.parse(best.modifiedTime) || Date.now()) / 1000,
			firstSeen: new Date().toISOString(),
		})
		return true
	}

	getChartsForSong(songKey: string): ChartData[] {
		const rows = this.db.prepare('SELECT data_json FROM charts WHERE song_key = ?').all(songKey) as { data_json: string }[]
		return rows.map(r => JSON.parse(r.data_json) as ChartData)
	}

	getChart(md5: string): ChartData | null {
		const row = this.db.prepare('SELECT data_json FROM charts WHERE md5 = ?').get(md5) as { data_json: string } | undefined
		return row ? JSON.parse(row.data_json) as ChartData : null
	}

	getSong(songKey: string): ReviewSong | null {
		const row = this.db.prepare('SELECT * FROM songs WHERE song_key = ?').get(songKey) as Record<string, unknown> | undefined
		return row ? this.rowToSong(row) : null
	}

	/** Marks pending songs as owned when they are already in the user's library. */
	markOwned(ownedSongKeys: Set<string>): number {
		const pending = this.db.prepare(`SELECT song_key FROM songs WHERE status = 'pending'`).all() as { song_key: string }[]
		const update = this.db.prepare(`UPDATE songs SET status = 'owned', decided_at = ? WHERE song_key = ?`)
		let count = 0
		this.db.transaction(() => {
			const now = new Date().toISOString()
			for (const { song_key } of pending) {
				if (ownedSongKeys.has(song_key)) {
					update.run(now, song_key)
					count++
				}
			}
		})()
		return count
	}

	/**
	 * Applies decisions; for each song the newest decision wins (`decided_at` is kept for undos too,
	 * so an older decision that syncs late can't override a newer undo).
	 * @returns the songs whose status changed.
	 */
	applyDecisions(decisions: ReviewDecision[]): ReviewSong[] {
		const changed: ReviewSong[] = []
		const update = this.db.prepare(`
      UPDATE songs SET status = @status, decided_at = @decidedAt
      WHERE song_key = @songKey AND status != 'owned' AND status != @status
        AND (decided_at IS NULL OR decided_at <= @decidedAt)
    `)
		this.db.transaction(() => {
			for (const decision of decisions) {
				const result = update.run({
					songKey: decision.songKey,
					status: decision.status,
					decidedAt: decision.decidedAt,
				})
				if (result.changes > 0) {
					const song = this.getSong(decision.songKey)
					if (song) { changed.push(song) }
				}
			}
		})()
		return changed
	}

	/** @returns pending songs in review order that have a clip ready. */
	getReviewBatch(count: number, excludeKeys: string[]): ReviewSong[] {
		const exclude = new Set(excludeKeys)
		const rows = this.db.prepare(`
      SELECT * FROM songs WHERE status = 'pending' AND clip_status = 'ready'
      ORDER BY queue_order LIMIT ?
    `).all(count + exclude.size) as Record<string, unknown>[]
		return rows.map(r => this.rowToSong(r)).filter(s => !exclude.has(s.songKey)).slice(0, count)
	}

	/** @returns pending songs in review order that still need a clip. */
	getSongsNeedingClips(limit: number, maxAttempts: number): ReviewSong[] {
		const rows = this.db.prepare(`
      SELECT * FROM songs
      WHERE status = 'pending' AND clip_status != 'ready' AND clip_attempts < ?
      ORDER BY queue_order LIMIT ?
    `).all(maxAttempts, limit) as Record<string, unknown>[]
		return rows.map(r => this.rowToSong(r))
	}

	countReadyClips(): number {
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE status = 'pending' AND clip_status = 'ready'`).get() as { n: number }).n
	}

	setClipReady(songKey: string, md5: string): void {
		this.db.prepare(`
      UPDATE songs SET clip_status = 'ready', clip_md5 = ?, clip_error = NULL, clip_attempts = clip_attempts + 1
      WHERE song_key = ?
    `).run(md5, songKey)
	}

	setClipFailed(songKey: string, error: string, maxAttempts: number): void {
		this.db.prepare(`
      UPDATE songs SET clip_error = ?, clip_attempts = clip_attempts + 1,
        clip_status = CASE WHEN clip_attempts + 1 >= ? THEN 'failed' ELSE clip_status END
      WHERE song_key = ?
    `).run(error, maxAttempts, songKey)
	}

	/** Forgets a song's clip and resets its attempts, so it can be generated again if the song becomes pending. */
	clearClip(songKey: string): void {
		this.db.prepare(`UPDATE songs SET clip_status = 'none', clip_md5 = NULL, clip_attempts = 0 WHERE song_key = ?`).run(songKey)
	}

	/** @returns decided songs that still have a clip on disk. */
	getDecidedSongsWithClips(): Array<{ songKey: string; clipMd5: string | null }> {
		const rows = this.db.prepare(`SELECT song_key, clip_md5 FROM songs WHERE status != 'pending' AND clip_status = 'ready'`)
			.all() as { song_key: string; clip_md5: string | null }[]
		return rows.map(r => ({ songKey: r.song_key, clipMd5: r.clip_md5 }))
	}

	/** @returns kept songs that haven't been downloaded (or whose download failed). */
	getSongsToDownload(): ReviewSong[] {
		const rows = this.db.prepare(`
      SELECT * FROM songs WHERE status = 'keep' AND (download_status IS NULL OR download_status = 'error')
      ORDER BY decided_at
    `).all() as Record<string, unknown>[]
		return rows.map(r => this.rowToSong(r))
	}

	setDownloadStatus(songKey: string, md5: string, status: ReviewDownloadStatus, error: string | null = null): void {
		this.db.prepare('UPDATE songs SET download_md5 = ?, download_status = ?, download_error = ? WHERE song_key = ?')
			.run(md5, status, error, songKey)
	}

	setDownloadStatusByMd5(md5: string, status: ReviewDownloadStatus, error: string | null = null): void {
		this.db.prepare('UPDATE songs SET download_status = ?, download_error = ? WHERE download_md5 = ?').run(status, error, md5)
	}

	getStats(): ReviewStats {
		const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'pending') AS pending,
        SUM(status = 'keep') AS keep,
        SUM(status = 'skip') AS skip,
        SUM(status = 'owned') AS owned,
        SUM(status = 'pending' AND clip_status = 'ready') AS clipsReady,
        SUM(status = 'pending' AND clip_status = 'failed') AS clipsFailed,
        SUM(download_status = 'queued') AS downloadQueued,
        SUM(download_status = 'done') AS downloaded,
        SUM(download_status = 'error') AS downloadFailed
      FROM songs
    `).get() as Record<string, number | null>
		return {
			total: row.total ?? 0,
			pending: row.pending ?? 0,
			keep: row.keep ?? 0,
			skip: row.skip ?? 0,
			owned: row.owned ?? 0,
			clipsReady: row.clipsReady ?? 0,
			clipsFailed: row.clipsFailed ?? 0,
			downloadQueued: row.downloadQueued ?? 0,
			downloaded: row.downloaded ?? 0,
			downloadFailed: row.downloadFailed ?? 0,
			lastSyncAt: this.getState('lastSyncAt'),
		}
	}

	listSongs(filter: ReviewSongFilter): ReviewSongPage {
		const where: string[] = []
		const params: Record<string, unknown> = {}
		if (filter.status !== 'all') {
			where.push('status = @status')
			params.status = filter.status
		}
		if (filter.search.trim()) {
			where.push('(artist LIKE @search OR name LIKE @search OR album LIKE @search OR charters LIKE @search)')
			params.search = `%${filter.search.trim()}%`
		}
		const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
		const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM songs ${whereClause}`).get(params) as { n: number }).n
		const order = filter.status === 'pending' ? 'queue_order' : 'COALESCE(decided_at, first_seen) DESC'
		const rows = this.db.prepare(`SELECT * FROM songs ${whereClause} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
			.all({ ...params, limit: filter.limit, offset: filter.offset }) as Record<string, unknown>[]
		return { songs: rows.map(r => this.rowToSong(r)), total }
	}

	private rowToSong(row: Record<string, unknown>): ReviewSong {
		return {
			songKey: row.song_key as string,
			artist: row.artist as string,
			name: row.name as string,
			album: (row.album as string) ?? '',
			genre: (row.genre as string) ?? '',
			year: (row.year as string) ?? '',
			songLength: row.song_length as number | null,
			albumArtMd5: row.album_art_md5 as string | null,
			chartCount: row.chart_count as number,
			charters: (row.charters as string) ?? '',
			bestMd5: row.best_md5 as string | null,
			status: row.status as ReviewSong['status'],
			decidedAt: row.decided_at as string | null,
			clipStatus: row.clip_status as ReviewSong['clipStatus'],
			clipMd5: row.clip_md5 as string | null,
			clipError: row.clip_error as string | null,
			downloadMd5: row.download_md5 as string | null,
			downloadStatus: row.download_status as ReviewSong['downloadStatus'],
			downloadError: row.download_error as string | null,
			firstSeen: row.first_seen as string,
		}
	}
}

// Singleton instance
let instance: ReviewDatabase | null = null

export function getReviewDb(): ReviewDatabase {
	if (!instance) {
		instance = new ReviewDatabase()
	}
	return instance
}
