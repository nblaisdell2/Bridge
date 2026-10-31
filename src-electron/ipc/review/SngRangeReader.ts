/**
 * Bridge Review - SNG range reader
 * Reads individual files out of a remote .sng archive using HTTP Range requests,
 * so only the needed bytes are downloaded.
 *
 * SNG layout (https://github.com/mdsitton/SngFileFormat):
 *   "SNGPKG" | version u32 | xorMask[16]
 *   metadataLen u64 | metadataCount u64 | (keyLen i32, key, valueLen i32, value)*
 *   fileMetaLen u64 | fileCount u64 | (nameLen u8, name, contentsLen u64, contentsIndex u64)*
 *   fileDataLen u64 | masked file contents
 *
 * File bytes are masked with `xorMask[i % 16] ^ (i & 0xFF)`, where `i` is the byte's
 * position inside its own file, so any range of a file can be unmasked on its own.
 */

export interface SngFileEntry {
	name: string
	size: number
	offset: number // Absolute offset of the file's first byte in the archive
}

const INITIAL_FETCH_BYTES = 64 * 1024
const MAX_HEADER_BYTES = 8 * 1024 * 1024

export class SngRangeReader {

	/** Total bytes downloaded by this reader (for logging/statistics) */
	bytesFetched = 0

	private xorMask = new Uint8Array(16)
	private _files: SngFileEntry[] = []
	private _metadata: Record<string, string> = {}

	constructor(readonly url: string, private signal?: AbortSignal) { }

	get files() { return this._files }
	get metadata() { return this._metadata }

	/** Fetches and parses the archive header, metadata, and file index. */
	async open() {
		let fetchBytes = INITIAL_FETCH_BYTES
		while (true) {
			const head = await this.fetchRange(0, fetchBytes - 1)
			const parsed = this.tryParseHeader(head)
			if (parsed === 'ok') { return }
			if (parsed === 'eof' || fetchBytes >= MAX_HEADER_BYTES) {
				throw new Error('SNG header could not be parsed')
			}
			fetchBytes = Math.min(Math.max(parsed, fetchBytes * 2), MAX_HEADER_BYTES)
		}
	}

	/**
	 * Reads `[start, end)` of a file inside the archive and unmasks it.
	 * `start` and `end` are positions relative to the start of that file.
	 */
	async readFile(file: SngFileEntry, start = 0, end = file.size) {
		start = Math.max(0, Math.floor(start))
		end = Math.min(file.size, Math.ceil(end))
		if (end <= start) { return new Uint8Array(0) }

		const bytes = await this.fetchRange(file.offset + start, file.offset + end - 1)
		for (let i = 0; i < bytes.length; i++) {
			const filePosition = start + i
			bytes[i] ^= this.xorMask[filePosition % 16] ^ (filePosition & 0xFF)
		}
		return bytes
	}

	private async fetchRange(start: number, endInclusive: number) {
		const response = await fetch(this.url, {
			headers: { Range: `bytes=${start}-${endInclusive}` },
			signal: this.signal,
		})
		if (response.status !== 206 && response.status !== 200) {
			throw new Error(`HTTP ${response.status} while fetching ${this.url}`)
		}
		let bytes = new Uint8Array(await response.arrayBuffer())
		if (response.status === 200) {
			// Server ignored the Range header; slice out the requested part
			bytes = bytes.slice(start, endInclusive + 1)
		}
		this.bytesFetched += bytes.length
		return bytes
	}

	/**
	 * @returns 'ok' when parsed, 'eof' when the archive is smaller than the header claims,
	 * or the number of bytes needed when `head` is too short.
	 */
	private tryParseHeader(head: Uint8Array): 'ok' | 'eof' | number {
		const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
		const decoder = new TextDecoder()

		if (decoder.decode(head.subarray(0, 6)) !== 'SNGPKG') {
			throw new Error('Not an SNG file')
		}
		this.xorMask = head.slice(10, 26)

		let p = 26
		const need = (bytes: number) => p + bytes > head.length

		if (need(8)) { return p + 8 }
		const metadataLen = Number(view.getBigUint64(p, true))
		p += 8
		if (need(metadataLen + 16)) { return p + metadataLen + 16 }

		const metadataEnd = p + metadataLen
		const metadataCount = Number(view.getBigUint64(p, true))
		p += 8
		const metadata: Record<string, string> = {}
		for (let i = 0; i < metadataCount; i++) {
			const keyLen = view.getInt32(p, true)
			p += 4
			const key = decoder.decode(head.subarray(p, p + keyLen))
			p += keyLen
			const valueLen = view.getInt32(p, true)
			p += 4
			metadata[key] = decoder.decode(head.subarray(p, p + valueLen))
			p += valueLen
		}
		p = metadataEnd

		const fileMetaLen = Number(view.getBigUint64(p, true))
		p += 8
		if (need(fileMetaLen)) { return p + fileMetaLen }
		const fileCount = Number(view.getBigUint64(p, true))
		p += 8
		const files: SngFileEntry[] = []
		for (let i = 0; i < fileCount; i++) {
			const nameLen = head[p]
			p += 1
			const name = decoder.decode(head.subarray(p, p + nameLen))
			p += nameLen
			const size = Number(view.getBigUint64(p, true))
			p += 8
			const offset = Number(view.getBigUint64(p, true))
			p += 8
			files.push({ name, size, offset })
		}

		if (fileCount > 0 && head.length < INITIAL_FETCH_BYTES && p >= head.length) { return 'eof' }

		this._metadata = metadata
		this._files = files
		return 'ok'
	}
}
