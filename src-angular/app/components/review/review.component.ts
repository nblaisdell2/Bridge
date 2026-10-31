import { DatePipe } from '@angular/common'
import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
import { NavigationEnd, Router } from '@angular/router'

import {
	ReviewProgress, ReviewServerInfo, ReviewSong, ReviewStats, ReviewStatus,
} from '../../../../src-shared/interfaces/review.interface.js'
import { SettingsService } from '../../core/services/settings.service'

const PAGE_SIZE = 50

@Component({
	selector: 'app-review',
	standalone: true,
	imports: [FormsModule, DatePipe],
	templateUrl: './review.component.html',
	host: { class: 'flex-1 min-h-0 flex flex-col' },
})
export class ReviewComponent implements OnInit, OnDestroy {
	settingsService = inject(SettingsService)
	private sanitizer = inject(DomSanitizer)
	readonly Math = Math

	stats = signal<ReviewStats | null>(null)
	serverInfo = signal<ReviewServerInfo | null>(null)
	syncProgress = signal<ReviewProgress | null>(null)
	clipProgress = signal<ReviewProgress | null>(null)
	downloadMessage = signal<string>('')
	tailscaleOutput = signal<string>('')
	settingUpTailscale = signal(false)

	showPlayer = signal(false)
	playerUrl = signal<SafeResourceUrl | null>(null)

	statusFilter = signal<ReviewStatus | 'all'>('keep')
	search = signal('')
	songs = signal<ReviewSong[]>([])
	songTotal = signal(0)
	page = signal(0)
	readonly pageSize = PAGE_SIZE

	private refreshTimer: ReturnType<typeof setTimeout> | undefined
	private pollTimer: ReturnType<typeof setInterval> | undefined

	constructor() {
		// This tab is kept alive when switching tabs, so close the player to stop its audio
		inject(Router).events.subscribe(event => {
			if (event instanceof NavigationEnd && !event.urlAfterRedirects.startsWith('/review') && this.showPlayer()) {
				this.togglePlayer()
			}
		})

		window.electron.on.reviewProgress(progress => {
			if (progress.kind === 'sync') {
				this.syncProgress.set(progress)
			} else if (progress.kind === 'clips') {
				this.clipProgress.set(progress)
			} else {
				this.downloadMessage.set(progress.message)
			}
			this.scheduleRefresh()
		})
	}

	async ngOnInit() {
		await Promise.all([this.refreshStats(), this.refreshServerInfo(), this.loadSongs()])
		// Decisions from the phone arrive without a progress event; keep the numbers current
		this.pollTimer = setInterval(() => this.refreshStats(), 10000)
	}

	ngOnDestroy() {
		clearInterval(this.pollTimer)
		clearTimeout(this.refreshTimer)
	}

	get syncRunning() {
		const progress = this.syncProgress()
		return progress !== null && !progress.finished
	}

	async refreshStats() {
		this.stats.set(await window.electron.invoke.reviewGetStats())
	}

	async refreshServerInfo() {
		const info = await window.electron.invoke.reviewGetServerInfo()
		this.serverInfo.set(info)
		this.playerUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(info.localUrl))
	}

	private scheduleRefresh() {
		clearTimeout(this.refreshTimer)
		this.refreshTimer = setTimeout(() => {
			this.refreshStats()
			this.loadSongs()
		}, 1000)
	}

	async sync() {
		this.syncProgress.set({ kind: 'sync', message: 'Starting sync...' })
		await window.electron.invoke.reviewSync()
	}

	async downloadKept() {
		const queued = await window.electron.invoke.reviewDownloadKept()
		this.downloadMessage.set(queued > 0
			? `Queued ${queued} kept song${queued === 1 ? '' : 's'} for download.`
			: 'All kept songs are already downloaded or queued.')
		await this.refreshStats()
	}

	async checkOwned() {
		const owned = await window.electron.invoke.reviewCheckOwned()
		this.downloadMessage.set(owned > 0
			? `Marked ${owned} song${owned === 1 ? '' : 's'} as already in your library.`
			: 'No new matches with your library. (Scan your library in the Library tab first.)')
		await Promise.all([this.refreshStats(), this.loadSongs()])
	}

	async setUpTailscale() {
		this.settingUpTailscale.set(true)
		const result = await window.electron.invoke.reviewSetupTailscale()
		this.tailscaleOutput.set(result.output)
		this.settingUpTailscale.set(false)
		await this.refreshServerInfo()
	}

	openUrl(url: string) {
		window.electron.emit.openUrl(url)
	}

	togglePlayer() {
		this.showPlayer.update(show => !show)
		if (!this.showPlayer()) { this.scheduleRefresh() }
	}

	setStatusFilter(status: ReviewStatus | 'all') {
		this.statusFilter.set(status)
		this.page.set(0)
		this.loadSongs()
	}

	onSearchChange(value: string) {
		this.search.set(value)
		this.page.set(0)
		this.loadSongs()
	}

	changePage(delta: number) {
		this.page.update(p => Math.max(0, p + delta))
		this.loadSongs()
	}

	async loadSongs() {
		const result = await window.electron.invoke.reviewListSongs({
			status: this.statusFilter(),
			search: this.search(),
			limit: PAGE_SIZE,
			offset: this.page() * PAGE_SIZE,
		})
		this.songs.set(result.songs)
		this.songTotal.set(result.total)
	}

	async setDecision(song: ReviewSong, status: 'keep' | 'skip' | 'pending') {
		await window.electron.invoke.reviewSetDecision({ songKey: song.songKey, status, decidedAt: new Date().toISOString() })
		await Promise.all([this.refreshStats(), this.loadSongs()])
	}

	setAutoSync(value: boolean) {
		this.settingsService.reviewAutoSync = value
	}

	setAutoDownload(value: boolean) {
		this.settingsService.reviewAutoDownload = value
	}

	percent(progress: ReviewProgress | null) {
		if (!progress?.total) { return null }
		return Math.min(100, Math.round((progress.done ?? 0) / progress.total * 100))
	}
}
