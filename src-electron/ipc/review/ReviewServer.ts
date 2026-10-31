/**
 * Bridge Review - Phone app server
 * Serves the review web app, preview clips, album art, and a small JSON API on localhost.
 * Phones reach it through `tailscale serve`, which provides HTTPS (required for offline web apps).
 */

import { createReadStream } from 'fs'
import { ensureDir, pathExists } from 'fs-extra'
import { stat, writeFile } from 'fs/promises'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import * as path from 'path'
import * as url from 'url'

import { ReviewBatchResponse, ReviewBatchSong, ReviewDecision, ReviewSong } from '../../../src-shared/interfaces/review.interface.js'
import { dataPath } from '../../../src-shared/Paths.js'
import { getClipFilePath } from './ClipService.js'
import { getReviewDb } from './ReviewDatabase.js'

const _dirname = path.dirname(url.fileURLToPath(import.meta.url))
/** Compiled phone app (dist/review-web), relative to dist/electron/src-electron/ipc/review */
const webRoot = path.join(_dirname, '..', '..', '..', '..', 'review-web')
const artCachePath = path.join(dataPath, 'review-art')
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_BATCH_SIZE = 1000

const contentTypes: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
}

export interface ReviewServerHooks {
	/** Called after decisions are applied with the songs whose status changed */
	onDecisions: (changed: ReviewSong[]) => void
	/** Called when the phone asks for more songs than have clips ready */
	onNeedClips: (readyCount: number) => void
}

let server: Server | null = null
let serverError: string | null = null

export function startReviewServer(port: number, hooks: ReviewServerHooks) {
	if (server) { return }
	serverError = null
	server = createServer((req, res) => {
		handleRequest(req, res, hooks).catch(err => {
			console.error('Review server error:', err)
			if (!res.headersSent) { sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }) }
		})
	})
	server.on('error', err => {
		serverError = err.message
		console.error('Review server failed:', err)
		server = null
	})
	// Bound to localhost only; Tailscale forwards phone traffic here
	server.listen(port, '127.0.0.1')
}

export function stopReviewServer() {
	server?.close()
	server = null
}

export function getReviewServerState() {
	return { running: server !== null && server.listening, error: serverError }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, hooks: ReviewServerHooks) {
	const requestUrl = new URL(req.url ?? '/', 'http://localhost')
	const pathname = decodeURIComponent(requestUrl.pathname)
	const db = getReviewDb()

	if (pathname === '/api/stats' && req.method === 'GET') {
		return sendJson(res, 200, db.getStats())
	}

	if (pathname === '/api/batch' && req.method === 'POST') {
		const body = await readJson<{ count?: number; exclude?: string[] }>(req)
		const count = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(body.count ?? 50)))
		const exclude = Array.isArray(body.exclude) ? body.exclude.filter(k => typeof k === 'string') : []
		const songs = db.getReviewBatch(count, exclude)
		if (songs.length < count) {
			hooks.onNeedClips(count + exclude.length)
		}
		const response: ReviewBatchResponse = { songs: songs.map(toBatchSong), stats: db.getStats() }
		return sendJson(res, 200, response)
	}

	if (pathname === '/api/sync' && req.method === 'POST') {
		const body = await readJson<{ decisions?: ReviewDecision[]; cachedKeys?: string[] }>(req)
		const decisions = (Array.isArray(body.decisions) ? body.decisions : []).filter(isValidDecision)
		const changed = db.applyDecisions(decisions)
		if (changed.length > 0) { hooks.onDecisions(changed) }

		// Tell the phone which of its cached songs no longer need review (e.g. decided at the PC)
		const cachedKeys = Array.isArray(body.cachedKeys) ? body.cachedKeys.filter(k => typeof k === 'string') : []
		const removedKeys = cachedKeys.filter(key => db.getSong(key)?.status !== 'pending')
		return sendJson(res, 200, { applied: decisions.length, removedKeys, stats: db.getStats() })
	}

	const clipMatch = pathname.match(/^\/api\/clip\/([a-f0-9]{32})\.mp3$/)
	if (clipMatch && req.method === 'GET') {
		return sendFile(req, res, getClipFilePath(clipMatch[1]), 'audio/mpeg', 'public, max-age=31536000, immutable')
	}

	const artMatch = pathname.match(/^\/api\/art\/([a-f0-9]{32})\.jpg$/)
	if (artMatch && req.method === 'GET') {
		const artPath = await getAlbumArt(artMatch[1])
		if (!artPath) { return sendJson(res, 404, { error: 'Album art not found' }) }
		return sendFile(req, res, artPath, 'image/jpeg', 'public, max-age=31536000, immutable')
	}

	if (pathname.startsWith('/api/')) {
		return sendJson(res, 404, { error: 'Not found' })
	}

	// Static files of the phone app
	const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
	const filePath = path.normalize(path.join(webRoot, relativePath))
	if (!filePath.startsWith(webRoot) || !(await pathExists(filePath)) || !(await stat(filePath)).isFile()) {
		return sendJson(res, 404, { error: 'Not found' })
	}
	const contentType = contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
	return sendFile(req, res, filePath, contentType, 'no-cache')
}

function toBatchSong(song: ReviewSong): ReviewBatchSong {
	return {
		songKey: song.songKey,
		artist: song.artist,
		name: song.name,
		album: song.album,
		genre: song.genre,
		year: song.year,
		songLength: song.songLength,
		chartCount: song.chartCount,
		charters: song.charters,
		clipUrl: `/api/clip/${song.clipMd5}.mp3`,
		artUrl: song.albumArtMd5 ? `/api/art/${song.albumArtMd5}.jpg` : null,
	}
}

function isValidDecision(decision: ReviewDecision) {
	return typeof decision?.songKey === 'string'
		&& ['keep', 'skip', 'pending'].includes(decision.status)
		&& typeof decision.decidedAt === 'string'
		&& !Number.isNaN(Date.parse(decision.decidedAt))
}

/** Downloads album art from Chorus once, then serves it from disk. */
async function getAlbumArt(md5: string) {
	const artPath = path.join(artCachePath, `${md5}.jpg`)
	if (await pathExists(artPath)) { return artPath }
	try {
		const response = await fetch(`https://files.enchor.us/${md5}.jpg`, { signal: AbortSignal.timeout(15000) })
		if (!response.ok) { return null }
		await ensureDir(artCachePath)
		await writeFile(artPath, Buffer.from(await response.arrayBuffer()))
		return artPath
	} catch {
		return null
	}
}

async function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, contentType: string, cacheControl: string) {
	if (!(await pathExists(filePath))) { return sendJson(res, 404, { error: 'Not found' }) }
	const { size } = await stat(filePath)
	const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' }

	// Safari requires byte-range support for media playback
	const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
	if (range && (range[1] || range[2])) {
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
		if (start >= size || start > end) {
			res.writeHead(416, { 'Content-Range': `bytes */${size}` })
			return res.end()
		}
		res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
		createReadStream(filePath, { start, end }).pipe(res)
		return
	}

	res.writeHead(200, { ...headers, 'Content-Length': size })
	if (req.method === 'HEAD') { return res.end() }
	createReadStream(filePath).pipe(res)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	const json = JSON.stringify(body)
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
	res.end(json)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > MAX_BODY_BYTES) { throw new Error('Request body too large') }
		chunks.push(chunk as Buffer)
	}
	if (size === 0) { return {} as T }
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export function isWebAppBuilt() {
	return pathExists(path.join(webRoot, 'index.html'))
}
