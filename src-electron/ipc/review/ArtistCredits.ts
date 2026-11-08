/**
 * Bridge Review - Artist credits
 * Works out which individual artists are credited on a song, so that artist mode can list each of them.
 * Chorus only has a free-text artist field, where "Lil Wayne & Drake" is two artists but "Coheed and Cambria"
 * is one, so names joined by an ambiguous separator are checked against the artists seen in the rest of the catalog.
 */

import { normalizeSongText } from '../../../src-shared/ReviewUtils.js'

export interface CreditedSong {
	songKey: string
	artist: string
	name: string
}

export interface ArtistIndex {
	/** Song key -> keys of every artist credited on it */
	artistsBySong: Map<string, string[]>
	/** Artist key -> keys of every song crediting them */
	songsByArtist: Map<string, string[]>
	/** Artist key -> the artist's most common spelling */
	artistNames: Map<string, string>
}

type IsKnownArtist = (name: string) => boolean

/** "feat." / "ft." / "featuring", optionally opening a bracket. "Little Feat" isn't followed by a name, so it doesn't match. */
const FEATURE_MARKER = /\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+/i
/** The featured artists in a song title: "(feat. Drake & Tems)" or "Creep ft. Haley Reinhart", but not "A Feat of Strength" */
const TITLE_FEATURES = /[([][^)\]]*?\b(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)|\s(?:feat\.|ft\.|featuring)\s+([^()[\]]+)/i
/** Separators that always mean different artists */
const COLLABORATION_SEPARATOR = /\s+vs\.?\s+|;\s+|\s+\/\s+|\\+/i
/** Separators that nearly always list artists: "Kid Cudi, King Chip" and "Ado x Rib" */
const LIST_SEPARATOR = /\s*,\s+(?:(?:&|and)\s+)?|\s+[x×]\s+/i
/** Separators that are as often part of a band's name as they are a collaboration */
const AMBIGUOUS_SEPARATOR = /\s+&\s+|\s+and\s+|\s+\+\s+|\s+with\s+|\//i
/** After a separator, these words usually continue a band's name: "Tyler, The Creator", "Dick Dale and His Del-Tones" */
const NAME_CONTINUATION = /^(?:the|and|of|his|her|their)\s/i
const ANY_SEPARATOR = new RegExp(`${LIST_SEPARATOR.source}|${AMBIGUOUS_SEPARATOR.source}`, 'i')

/** @returns the key that identifies an artist, ignoring case, punctuation, and a leading "The". */
function getArtistKey(name: string) {
	const text = normalizeSongText(name)
	return text.replace(/^the /, '').replace(/[^\p{L}\p{N}]/gu, '') || text
}

/** @returns every song's credited artists, indexed for artist mode. */
export function buildArtistIndex(songs: CreditedSong[]): ArtistIndex {
	const knownArtists = collectKnownArtists(songs)
	const isKnown: IsKnownArtist = name => knownArtists.has(getArtistKey(name))

	const artistsBySong = new Map<string, string[]>()
	const songsByArtist = new Map<string, string[]>()
	const spellings = new Map<string, Map<string, number>>()

	for (const song of songs) {
		const keys = new Set<string>()
		for (const name of getCreditedArtists(song.artist, song.name, isKnown)) {
			const key = getArtistKey(name)
			if (!key) { continue }
			keys.add(key)
			const counts = spellings.get(key) ?? new Map<string, number>()
			counts.set(name, (counts.get(name) ?? 0) + 1)
			spellings.set(key, counts)
		}
		artistsBySong.set(song.songKey, [...keys])
		for (const key of keys) {
			const artistSongs = songsByArtist.get(key)
			if (artistSongs) { artistSongs.push(song.songKey) } else { songsByArtist.set(key, [song.songKey]) }
		}
	}

	const artistNames = new Map<string, string>()
	for (const [key, counts] of spellings) {
		artistNames.set(key, [...counts].sort((a, b) => b[1] - a[1])[0][0])
	}
	return { artistsBySong, songsByArtist, artistNames }
}

/**
 * @returns the individual artists credited on a song.
 * @param isKnown Whether a name is known to be an artist from elsewhere in the catalog.
 */
function getCreditedArtists(artist: string, songName: string, isKnown: IsKnownArtist) {
	const { main, featured } = separateFeatures(artist)
	const titleFeatures = getTitleFeatures(songName)
	const names = [
		...main.split(COLLABORATION_SEPARATOR).flatMap(segment => splitCredit(segment.trim(), isKnown)),
		...(featured ? splitFeatures(featured, isKnown) : []),
		...(titleFeatures ? splitFeatures(titleFeatures, isKnown) : []),
	]
	return [...new Set(names.map(name => name.trim()).filter(name => name))]
}

/** @returns every name that can be trusted to be an artist, used to judge the ambiguous credits. */
function collectKnownArtists(songs: CreditedSong[]) {
	const known = new Set<string>()
	const add = (name: string) => {
		const key = getArtistKey(name)
		if (key.length > 1) { known.add(key) }
	}
	const isKnown: IsKnownArtist = name => known.has(getArtistKey(name))
	const noneKnown: IsKnownArtist = () => false
	const firstListedWith = new Map<string, Set<string>>()
	const credits = new Set(songs.map(song => song.artist))

	for (const credit of credits) {
		add(credit) // Whole credits are included for bands that get featured, such as "Earth, Wind & Fire"
		for (const segment of separateFeatures(credit).main.split(COLLABORATION_SEPARATOR)) {
			add(segment)
			if (hasBrackets(segment)) { continue }

			// Someone listed with two unrelated groups of people is an artist, even without a song to themselves
			const listed = splitNames(segment, LIST_SEPARATOR, noneKnown).map(getArtistKey)
			if (listed.length < 2) { continue }
			for (const key of listed) {
				const others = listed.filter(other => other !== key)
				const firstOthers = firstListedWith.get(key)
				if (!firstOthers) {
					firstListedWith.set(key, new Set(others))
				} else if (key.length > 1 && !others.some(other => firstOthers.has(other))) {
					known.add(key)
				}
			}
		}
	}

	// Featured names come last, so that a featured band's name can be recognized as a whole
	for (const credit of credits) {
		const { featured } = separateFeatures(credit)
		if (featured) { splitFeatures(featured, isKnown).forEach(add) }
	}
	for (const song of songs) {
		const titleFeatures = getTitleFeatures(song.name)
		if (titleFeatures) { splitFeatures(titleFeatures, isKnown).forEach(add) }
	}
	return known
}

/** Separates the featured artists from the rest of an artist credit. */
function separateFeatures(artist: string) {
	const text = cleanText(artist)
	const marker = text.match(FEATURE_MARKER)
	if (!marker?.index) { return { main: text, featured: null } }
	const rest = text.slice(marker.index + marker[0].length)
	return { main: text.slice(0, marker.index), featured: rest.replace(/\s*[()[\]].*$/, '') }
}

function getTitleFeatures(songName: string) {
	const match = cleanText(songName).match(TITLE_FEATURES)
	return match?.[1] ?? match?.[2] ?? null
}

/** Splits a list of featured artists, which is a list by definition unless it's the exact name of a band. */
function splitFeatures(featured: string, isKnown: IsKnownArtist) {
	return isKnown(featured) ? [featured] : splitNames(featured, ANY_SEPARATOR, isKnown)
}

/** Splits one credit into artists, if the catalog supports reading it as more than one. */
function splitCredit(credit: string, isKnown: IsKnownArtist): string[] {
	// Notes such as "JO STARS (TOMMY, Coda, JIN)" don't name separate credits
	if (hasBrackets(credit)) { return [credit] }

	const items = splitNames(credit, LIST_SEPARATOR, isKnown)
	if (items.length < 2) { return splitAmbiguous(credit, isKnown) }

	// The last item of "A, B & C" is two names
	const last = items[items.length - 1]
	const lastNames = isKnown(last) ? [last] : splitNames(last, AMBIGUOUS_SEPARATOR, isKnown)
	const names = [...items.slice(0, -1), ...lastNames]

	// Three or more plain commas are always a list. Shorter lists and ones ending in "& Name" could be a band
	// ("Oh, Sleeper", "Earth, Wind & Fire"), so they need a recognized full name or mostly recognized names.
	const isPlainList = items.length >= 3 && !/\s(?:&|and)\s/i.test(credit)
	const knownNames = names.filter(isKnown)
	const isRecognized = knownNames.some(name => name.includes(' ')) || knownNames.length * 2 >= names.length
	const isList = (isPlainList || isRecognized) && names.every(name => getArtistKey(name).length > 1)
	return isList ? names.flatMap(name => splitAmbiguous(name, isKnown)) : [credit]
}

/**
 * Splits "A & B" when both are recognized artists, or one is and both are full names ("Jack White & Alicia Keys").
 * Band names like "Love & Rockets" don't pass, even though Love is also a band.
 */
function splitAmbiguous(credit: string, isKnown: IsKnownArtist) {
	const names = splitNames(credit, AMBIGUOUS_SEPARATOR, isKnown)
	const knownCount = names.filter(isKnown).length
	const isCollaboration = knownCount === names.length || (knownCount > 0 && names.every(name => name.includes(' ')))
	return names.length > 1 && isCollaboration ? names : [credit]
}

/** Splits `text` on `separator`, leaving names like "Tom Petty and the Heartbreakers" in one piece. */
function splitNames(text: string, separator: RegExp, isKnown: IsKnownArtist) {
	const pieces = text.split(new RegExp(`(${separator.source})`, 'i')) // [name, separator, name, separator, name]
	const names = [pieces[0]]
	for (let i = 1; i < pieces.length; i += 2) {
		const name = pieces[i + 1]
		if (NAME_CONTINUATION.test(name) && !isKnown(name)) {
			names[names.length - 1] += pieces[i] + name
		} else {
			names.push(name)
		}
	}
	return names.map(name => name.trim()).filter(name => name)
}

function hasBrackets(text: string) {
	return /[([]/.test(text)
}

function cleanText(text: string) {
	return text.normalize('NFKC').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}
