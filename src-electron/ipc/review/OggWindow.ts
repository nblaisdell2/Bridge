/**
 * Bridge Review - Ogg page helpers
 * Builds a small, decodable Ogg stream from a stem's header pages plus a window of
 * audio pages taken from the middle of the file, and reports where that window
 * starts in time so multiple stems can be aligned precisely.
 */

export type OggCodec = 'opus' | 'vorbis'

export interface OggPage {
	start: number           // Byte offset of the page in the buffer it was parsed from
	length: number          // Total page length in bytes
	headerType: number      // 0x01 = continued packet, 0x02 = first page, 0x04 = last page
	granule: bigint         // -1 when no packet ends on this page
	packetsCompleted: number
}

export interface OggHeaders {
	codec: OggCodec
	/** Header pages ready to prepend to an audio window (Opus pre-skip zeroed, CRCs fixed) */
	bytes: Uint8Array
	/** Samples (at `sampleRate`) to subtract from granule positions to get presentation time */
	preSkip: number
	/** Rate that granule positions are measured in */
	sampleRate: number
}

export interface OggAudioWindow {
	/** Pages that start on a packet boundary, ready to append after the header pages */
	bytes: Uint8Array
	/** Granule position of the first sample produced by `bytes` */
	startGranule: bigint
	/** Granule position at the end of `bytes` */
	endGranule: bigint
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let i = 0; i < 256; i++) {
		let r = i << 24
		for (let j = 0; j < 8; j++) {
			r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1)
		}
		table[i] = r >>> 0
	}
	return table
})()

function oggCrc(bytes: Uint8Array) {
	let crc = 0
	for (let i = 0; i < bytes.length; i++) {
		crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xFF]) >>> 0
	}
	return crc
}

/** Recomputes the CRC of a complete page in place. */
function fixPageCrc(page: Uint8Array) {
	page.fill(0, 22, 26)
	new DataView(page.buffer, page.byteOffset, page.byteLength).setUint32(22, oggCrc(page), true)
}

/**
 * Parses the page that starts at `pos`, verifying its capture pattern and CRC.
 * @returns the page, `null` if no valid page starts there, or 'truncated' if the buffer ends mid-page.
 */
export function parsePageAt(buffer: Uint8Array, pos: number): OggPage | null | 'truncated' {
	if (pos + 27 > buffer.length) { return 'truncated' }
	if (buffer[pos] !== 0x4F || buffer[pos + 1] !== 0x67 || buffer[pos + 2] !== 0x67 || buffer[pos + 3] !== 0x53) { return null }
	if (buffer[pos + 4] !== 0) { return null }

	const segmentCount = buffer[pos + 26]
	if (pos + 27 + segmentCount > buffer.length) { return 'truncated' }
	let bodyLength = 0
	let packetsCompleted = 0
	for (let i = 0; i < segmentCount; i++) {
		const lacing = buffer[pos + 27 + i]
		bodyLength += lacing
		if (lacing < 255) { packetsCompleted++ }
	}
	const length = 27 + segmentCount + bodyLength
	if (pos + length > buffer.length) { return 'truncated' }

	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
	const page = buffer.slice(pos, pos + length)
	const storedCrc = view.getUint32(pos + 22, true)
	page.fill(0, 22, 26)
	if (oggCrc(page) !== storedCrc) { return null }

	return {
		start: pos,
		length,
		headerType: buffer[pos + 5],
		granule: view.getBigInt64(pos + 6, true),
		packetsCompleted,
	}
}

/**
 * Reads the codec header pages from the start of a stem.
 * @returns the headers, or the number of bytes needed if `bytes` is too short.
 */
export function readOggHeaders(bytes: Uint8Array): OggHeaders | number {
	const first = parsePageAt(bytes, 0)
	if (first === 'truncated') { return Math.max(bytes.length * 2, 4096) }
	if (first === null) { throw new Error('Stem is not an Ogg stream') }

	const packetStart = 27 + bytes[26]
	const magic = new TextDecoder().decode(bytes.subarray(packetStart, packetStart + 8))
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	let codec: OggCodec
	let preSkip = 0
	let sampleRate: number
	let headerPacketCount: number
	if (magic === 'OpusHead') {
		codec = 'opus'
		preSkip = view.getUint16(packetStart + 10, true)
		sampleRate = 48000 // Opus granule positions are always 48 kHz
		headerPacketCount = 2
	} else if (magic.substring(1, 7) === 'vorbis' && bytes[packetStart] === 1) {
		codec = 'vorbis'
		sampleRate = view.getUint32(packetStart + 12, true)
		headerPacketCount = 3
	} else {
		throw new Error('Unsupported Ogg codec')
	}

	let pos = 0
	let packets = 0
	while (packets < headerPacketCount) {
		const page = parsePageAt(bytes, pos)
		if (page === 'truncated') { return Math.max(bytes.length * 2, pos + 65536) }
		if (page === null) { throw new Error('Corrupt Ogg header pages') }
		packets += page.packetsCompleted
		pos += page.length
	}

	const headerBytes = bytes.slice(0, pos)
	if (codec === 'opus') {
		// Zero the pre-skip so decoded output starts exactly at the window's first granule
		new DataView(headerBytes.buffer).setUint16(packetStart + 10, 0, true)
		fixPageCrc(headerBytes.subarray(0, first.length))
	}

	return { codec, bytes: headerBytes, preSkip, sampleRate }
}

/** Finds the first valid page in `chunk` that has a granule position. */
export function findTimestampedPage(chunk: Uint8Array): OggPage | null {
	for (let pos = 0; pos < chunk.length - 27; pos++) {
		let page = parsePageAt(chunk, pos)
		if (page === 'truncated') { return null }
		while (page !== null && page !== 'truncated') {
			if (page.granule >= 0n) { return page }
			page = parsePageAt(chunk, page.start + page.length)
		}
		if (page === 'truncated') { return null }
	}
	return null
}

/**
 * Finds the decodable part of a window of bytes taken from the middle of a stem.
 * The returned bytes start on a page whose first packet is not continued from an earlier page,
 * so the first sample it produces is at the previous page's granule position.
 */
export function findAudioWindow(chunk: Uint8Array): OggAudioWindow | null {
	// Locate the first valid page
	let pos = 0
	let firstPage: OggPage | null = null
	for (; pos < chunk.length - 27; pos++) {
		const page = parsePageAt(chunk, pos)
		if (page === 'truncated') { return null }
		if (page !== null) {
			firstPage = page
			break
		}
	}
	if (firstPage === null) { return null }

	let previous: OggPage = firstPage
	let startByte = -1
	let startGranule = -1n
	let endByte = -1
	let endGranule = -1n
	pos = previous.start + previous.length

	while (true) {
		const next = parsePageAt(chunk, pos)
		if (next === null || next === 'truncated') { break }

		if (startByte === -1) {
			if ((next.headerType & 0x01) === 0 && previous.granule >= 0n) {
				startByte = next.start
				startGranule = previous.granule
			}
		}
		if (startByte !== -1 && next.granule >= 0n) {
			endByte = next.start + next.length
			endGranule = next.granule
		}

		previous = next
		pos = next.start + next.length
	}

	if (startByte === -1 || endByte === -1) { return null }
	return { bytes: chunk.subarray(startByte, endByte), startGranule, endGranule }
}
