/**
 * Bridge Review - Clip extractor
 * Creates a short, loudness-normalized MP3 preview clip for a chart on Chorus Encore,
 * downloading only the part of each audio stem around the chart's preview start time.
 */

import { spawn } from 'child_process'
import { rename, writeFile } from 'fs/promises'

import { findAudioWindow, findTimestampedPage, OggHeaders, readOggHeaders } from './OggWindow.js'
import { SngFileEntry, SngRangeReader } from './SngRangeReader.js'

export interface ClipRequest {
	md5: string
	hasVideoBackground: boolean
	previewStartMs: number | null // From the Chorus API; values <= 0 are treated as missing
	songLengthMs: number | null
	clipSeconds: number
	outputPath: string
	ffmpegPath: string
	signal?: AbortSignal
}

export interface ClipResult {
	bytesFetched: number
	stems: string[]
	startSeconds: number
	durationSeconds: number
}

const SAMPLE_RATE = 44100
const CHANNELS = 2
const WINDOW_MARGIN_SECONDS = 3
const SEEK_TOLERANCE_SECONDS = 4
const MAX_SEEK_PROBES = 10
const MAX_WINDOW_EXTENSIONS = 8
const PROBE_BYTES = 24 * 1024
const STEM_CONCURRENCY = 3
const AUDIO_EXTENSIONS = /\.(ogg|opus|mp3|wav|m4a|flac)$/i
const OGG_EXTENSIONS = /\.(ogg|opus)$/i
/** Where to start the clip, as a fraction of the song, when the chart has no preview start time */
const DEFAULT_PREVIEW_FRACTION = 0.35

export async function extractClip(request: ClipRequest): Promise<ClipResult> {
	const url = `https://files.enchor.us/${request.md5}${request.hasVideoBackground ? '_novideo' : ''}.sng`
	const reader = new SngRangeReader(url, request.signal)
	await reader.open()

	// Same stem selection as the chart preview player: everything except crowd noise and preview files
	// (preview files are often short placeholders or silence)
	const stems = reader.files.filter(f => AUDIO_EXTENSIONS.test(f.name) && !/^(crowd|preview)$/i.test(stemName(f.name)))
	if (stems.length === 0) { throw new Error('Chart has no audio files') }

	const songLengthMs = positiveOrNull(request.songLengthMs) ?? positiveOrNull(Number(reader.metadata['song_length'])) ?? 0
	const previewStartMs = positiveOrNull(request.previewStartMs) ?? positiveOrNull(Number(reader.metadata['preview_start_time']))
	let startSeconds = previewStartMs !== null ? previewStartMs / 1000 : songLengthMs / 1000 * DEFAULT_PREVIEW_FRACTION
	let durationSeconds = request.clipSeconds
	if (songLengthMs > 0) {
		durationSeconds = Math.min(durationSeconds, songLengthMs / 1000)
		startSeconds = Math.max(0, Math.min(startSeconds, songLengthMs / 1000 - durationSeconds))
	}

	const frameCount = Math.round(durationSeconds * SAMPLE_RATE)
	const mix = new Float32Array(frameCount * CHANNELS)
	const usedStems: string[] = []

	await runPool(stems, STEM_CONCURRENCY, async stem => {
		const decoded = await decodeStemWindow(reader, stem, {
			startSeconds,
			durationSeconds,
			songLengthSeconds: songLengthMs / 1000,
			ffmpegPath: request.ffmpegPath,
			signal: request.signal,
		})
		const pcm = decoded.pcm
		const pcmFrames = pcm.length / CHANNELS
		for (let i = 0; i < frameCount; i++) {
			const source = decoded.offsetFrames + i
			if (source < 0) { continue }
			if (source >= pcmFrames) { break }
			mix[i * 2] += pcm[source * 2]
			mix[i * 2 + 1] += pcm[source * 2 + 1]
		}
		usedStems.push(stem.name)
	})

	const fadeOutSeconds = Math.min(1.5, durationSeconds / 4)
	const filters = [
		'loudnorm=I=-16:TP=-1.5:LRA=11',
		`afade=t=in:d=${Math.min(0.5, durationSeconds / 4)}`,
		`afade=t=out:st=${(durationSeconds - fadeOutSeconds).toFixed(3)}:d=${fadeOutSeconds.toFixed(3)}`,
	].join(',')
	const mp3 = await runFfmpeg(request.ffmpegPath, [
		'-f', 'f32le', '-ar', `${SAMPLE_RATE}`, '-ac', `${CHANNELS}`, '-i', 'pipe:0',
		'-af', filters,
		'-ar', `${SAMPLE_RATE}`, '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
	], new Uint8Array(mix.buffer), request.signal)

	const tempPath = request.outputPath + '.tmp'
	await writeFile(tempPath, mp3)
	await rename(tempPath, request.outputPath)

	return { bytesFetched: reader.bytesFetched, stems: usedStems, startSeconds, durationSeconds }
}

interface DecodeOptions {
	startSeconds: number
	durationSeconds: number
	songLengthSeconds: number
	ffmpegPath: string
	signal?: AbortSignal
}

interface DecodedStem {
	pcm: Float32Array
	/** The frame in `pcm` that corresponds to the clip's start */
	offsetFrames: number
}

async function decodeStemWindow(reader: SngRangeReader, stem: SngFileEntry, options: DecodeOptions): Promise<DecodedStem> {
	const decodeArgs = ['-f', 'f32le', '-ar', `${SAMPLE_RATE}`, '-ac', `${CHANNELS}`, 'pipe:1']

	if (!OGG_EXTENSIONS.test(stem.name)) {
		// Download the whole stem and let ffmpeg trim it (exact, but larger download)
		const bytes = await reader.readFile(stem)
		const pcm = await runFfmpeg(options.ffmpegPath, [
			'-ss', options.startSeconds.toFixed(3), '-i', 'pipe:0', '-t', options.durationSeconds.toFixed(3), ...decodeArgs,
		], bytes, options.signal)
		return { pcm: toFloat32(pcm), offsetFrames: 0 }
	}

	const { stream, windowStartSeconds } = await fetchStemWindow(reader, stem, options)
	const pcm = await runFfmpeg(options.ffmpegPath, ['-i', 'pipe:0', ...decodeArgs], stream, options.signal)
	return {
		pcm: toFloat32(pcm),
		offsetFrames: Math.round((options.startSeconds - windowStartSeconds) * SAMPLE_RATE),
	}
}

/**
 * Downloads just enough of an Ogg stem to cover the clip, and returns it as a standalone Ogg stream.
 * Opus and Vorbis are variable bitrate (quiet passages are tiny), so the start position is found with an
 * interpolation search on page timestamps instead of assuming bytes are proportional to time.
 */
export async function fetchStemWindow(
	reader: SngRangeReader,
	stem: SngFileEntry,
	options: Pick<DecodeOptions, 'startSeconds' | 'durationSeconds' | 'songLengthSeconds'>,
) {
	const headers = await readHeaders(reader, stem)
	const targetStart = Math.max(0, options.startSeconds - WINDOW_MARGIN_SECONDS)
	const clipEnd = options.startSeconds + options.durationSeconds

	// Aim for the middle of the acceptable band, and fall back to bisection when one side keeps moving,
	// so the search can't stall approaching the target from one direction
	const aimTime = targetStart - SEEK_TOLERANCE_SECONDS / 2
	let lo: GranuleProbe = { byte: headers.bytes.length, time: 0 }
	let hi: GranuleProbe = { byte: stem.size, time: Math.max(options.songLengthSeconds, clipEnd) }
	let sameSideCount = 0
	let lastSide: 'lo' | 'hi' | null = null
	for (let i = 0; i < MAX_SEEK_PROBES && targetStart > SEEK_TOLERANCE_SECONDS; i++) {
		const fraction = sameSideCount >= 2
			? 0.5
			: Math.max(0, Math.min(1, (aimTime - lo.time) / Math.max(1e-6, hi.time - lo.time)))
		const guess = Math.floor(lo.byte + fraction * (hi.byte - lo.byte))
		const probe = await probeGranule(reader, stem, headers, guess)
		const side = probe === null || probe.time > targetStart ? 'hi' : 'lo'
		if (side === 'hi') {
			hi = probe ?? { byte: guess, time: hi.time }
		} else {
			lo = probe!
		}
		sameSideCount = side === lastSide ? sameSideCount + 1 : 1
		lastSide = side
		if (side === 'lo' && targetStart - lo.time < SEEK_TOLERANCE_SECONDS) { break }
		if (hi.byte - lo.byte <= PROBE_BYTES) { break }
	}

	// Fetch from the page found above until the clip is covered
	const bytesPerSecond = (hi.byte - lo.byte) / Math.max(1, hi.time - lo.time)
	let endByte = Math.min(stem.size, Math.ceil(lo.byte + (clipEnd + WINDOW_MARGIN_SECONDS - lo.time) * bytesPerSecond * 1.1))
	let chunk = await reader.readFile(stem, lo.byte, endByte)
	let window = findAudioWindow(chunk)
	for (let i = 0; i < MAX_WINDOW_EXTENSIONS && endByte < stem.size; i++) {
		if (window && granuleSeconds(window.endGranule, headers) >= clipEnd) { break }
		const extra = await reader.readFile(stem, endByte, Math.min(stem.size, endByte + Math.max(PROBE_BYTES * 4, chunk.length / 2)))
		const combined = new Uint8Array(chunk.length + extra.length)
		combined.set(chunk, 0)
		combined.set(extra, chunk.length)
		chunk = combined
		endByte += extra.length
		window = findAudioWindow(chunk)
	}
	if (!window) { throw new Error(`Could not find audio pages in ${stem.name}`) }

	const stream = new Uint8Array(headers.bytes.length + window.bytes.length)
	stream.set(headers.bytes, 0)
	stream.set(window.bytes, headers.bytes.length)
	return { stream, windowStartSeconds: granuleSeconds(window.startGranule, headers) }
}

interface GranuleProbe {
	byte: number // Position of a page in the stem
	time: number // Presentation time at the end of that page, in seconds
}

/** Finds the first timestamped page at or after `byte`, or `null` if there is none. */
async function probeGranule(reader: SngRangeReader, stem: SngFileEntry, headers: OggHeaders, byte: number): Promise<GranuleProbe | null> {
	let size = PROBE_BYTES
	for (let attempt = 0; attempt < 3; attempt++) {
		const chunk = await reader.readFile(stem, byte, Math.min(stem.size, byte + size))
		const page = findTimestampedPage(chunk)
		if (page) { return { byte: byte + page.start, time: granuleSeconds(page.granule, headers) } }
		if (byte + size >= stem.size) { return null }
		size *= 4
	}
	return null
}

async function readHeaders(reader: SngRangeReader, stem: SngFileEntry) {
	let bytes = await reader.readFile(stem, 0, Math.min(stem.size, 8192))
	while (true) {
		const headers = readOggHeaders(bytes)
		if (typeof headers !== 'number') { return headers }
		if (bytes.length >= stem.size) { throw new Error(`Incomplete Ogg headers in ${stem.name}`) }
		bytes = await reader.readFile(stem, 0, Math.min(stem.size, headers))
	}
}

function granuleSeconds(granule: bigint, headers: OggHeaders) {
	return Number(granule - BigInt(headers.preSkip)) / headers.sampleRate
}

function runFfmpeg(ffmpegPath: string, args: string[], input: Uint8Array, signal?: AbortSignal) {
	return new Promise<Buffer>((resolve, reject) => {
		const process = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, signal })
		const output: Buffer[] = []
		let stderr = ''
		process.stdout.on('data', (data: Buffer) => output.push(data))
		process.stderr.on('data', data => stderr += data.toString())
		process.on('error', reject)
		process.on('close', code => {
			if (code === 0) {
				resolve(Buffer.concat(output))
			} else {
				reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-500)}`))
			}
		})
		process.stdin.on('error', () => { /* ffmpeg may close stdin early; the exit code reports real errors */ })
		process.stdin.end(input)
	})
}

function toFloat32(buffer: Buffer) {
	const aligned = new Uint8Array(buffer.length - (buffer.length % 4))
	aligned.set(buffer.subarray(0, aligned.length))
	return new Float32Array(aligned.buffer)
}

async function runPool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>) {
	let next = 0
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			await task(items[next++])
		}
	})
	await Promise.all(workers)
}

function positiveOrNull(value: number | null | undefined) {
	return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null
}

function baseName(path: string) {
	return path.split('/').pop() ?? path
}

function stemName(path: string) {
	return baseName(path).replace(/\.[^.]+$/, '')
}
