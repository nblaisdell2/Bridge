import { ChartData } from './interfaces/search.interface.js'

/**
 * @returns the key used to group charts of the same song: normalized `artist|name`.
 * (Chorus' `songId` is null for most recently added charts, so it can't be used for grouping.)
 */
export function getSongKey(artist: string | null, name: string | null) {
	return `${normalizeSongText(artist)}|${normalizeSongText(name)}`
}

export function normalizeSongText(text: string | null) {
	return (text ?? '')
		.normalize('NFKC')
		.replace(/<[^>]*>/g, '') // Clone Hero color/formatting tags
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Sorts the charts of one song from most to least preferred for a drummer:
 * reviewed drums, pro drums, 4-lane over 5-lane, fewest issues, most instruments, newest.
 */
export function rankCharts<T extends ChartData>(charts: T[]): T[] {
	return [...charts].sort((a, b) => {
		const scoreA = chartScore(a)
		const scoreB = chartScore(b)
		for (let i = 0; i < scoreA.length; i++) {
			if (scoreA[i] !== scoreB[i]) { return scoreB[i] - scoreA[i] }
		}
		return 0
	})
}

function chartScore(chart: ChartData) {
	const drumType = chart.notesData?.drumType ?? null
	const issueCount = (chart.notesData?.chartIssues?.length ?? 0)
		+ (chart.folderIssues?.length ?? 0)
		+ (chart.metadataIssues?.length ?? 0)
	return [
		(chart as ChartData & { drumsReviewed?: boolean }).drumsReviewed ? 1 : 0,
		drumType === 1 || chart.pro_drums ? 1 : 0,
		drumType === 2 || chart.five_lane_drums ? 0 : 1,
		-issueCount,
		chart.notesData?.instruments?.length ?? 0,
		Date.parse(chart.modifiedTime) || 0,
	]
}
