<p align="center">
  <img src="./src-angular/assets/images/bridge-animation.gif"/>
</p>
<h3 align="center">A rhythm game chart searching and downloading tool.</h3>
<img align="center" src="./src-angular/assets/images/example.png"/>
<hr>

**Bridge** is a desktop application that allows you to search for and download charts that can be played in  games like Clone Hero, YARG, etc...

This is the desktop version of [Chorus Encore](https://www.enchor.us/).

## Setup

Head over to the [Releases](https://github.com/Geomitron/Bridge/releases) page to download the install wizard. (Windows 10/11, Mac, and Linux versions are available)

## Features

- ✅ Find all charts that can be found on Chorus Encore.
- ✅ Download any chart directly into your chart library as a chart folder or `.sng` file.
- ✅ Multi-select songs to add to the download queue.
- ✅ Cancel and retry downloads.
- ✅ In-app update checking and downloading.
- ✅ A variety of themes.
- ✅ Advanced song search.
- ✅ Chart issue scanner (for people making charts).
- ✅ Review mode: hear a short preview of every song and keep or skip it, on your PC or offline on your phone. *(Added in this fork; see [Review mode](#review-mode) below.)*

### What's new in v3.4.0

- Add new "Quality Reviewed" filter for drum charts

### Development

Built using Node.js, Angular, and Electron.

Learn how to install Node.js [here](https://nodejs.dev/en/download/)

After installing Node.js and cloning the repository, install dependencies and run development with:

```
$ npm install && npm start
```

### Socials

To discuss the project and make suggestions, please join the [Discord](https://discord.gg/cqaUXGm)

To help me pay for the server costs, please check out the [Patreon](https://www.patreon.com/ChorusEncore701)

<hr>

## Additions in this fork

> This is [nblaisdell2/Bridge](https://github.com/nblaisdell2/Bridge), a fork of [Geomitron/Bridge](https://github.com/Geomitron/Bridge). Everything above this line is from the original project. The sections below describe what this fork adds.

### Review mode

Chorus Encore has tens of thousands of charts, and finding the ones you want by scrolling through search results and opening each chart's preview is slow. Review mode turns it into a quick listening session: Bridge plays a short clip of each song, Rock Band style, and you keep or skip it. Kept songs are downloaded to your library automatically.

**How it works**

- **Import:** Bridge pulls every chart for the review instrument and difficulty (Expert drums by default) from Chorus Encore. Charts of the same song by different charters are grouped, so each song is reviewed once.
- **Clips:** each song gets a 30 second clip that starts at the chart's preview point (or about a third of the way in when the chart doesn't set one). Bridge downloads only the part of each audio track around that point (about 0.5–4 MB per song instead of the whole chart), mixes the tracks, and evens out the volume. Clips are prepared in the background a few hundred songs ahead and deleted once you've decided.
- **Downloads:** when you keep a song, Bridge downloads the best chart for it through the normal download queue: reviewed drums first, then pro drums, then fewest chart issues, most instruments, and newest. Downloads go to your default library folder using your folder-name setting.
- **New charts:** Bridge checks Chorus for new charts when it starts and once a day while it's open. New songs are placed at the front of your review queue, ahead of the backlog.
- **Songs you already have:** after you scan your library in the Library tab, click **Skip songs already in my library** in the Review tab to mark matching songs as owned so they never come up.

**Using it on your PC**

1. Open the **Review** tab and click **Import catalog** (takes a few minutes the first time).
2. Click **Open player** to review in Bridge. Keyboard shortcuts: → keep, ← skip, ↓ later, Z undo, Space play/pause.
3. The song list at the bottom of the tab shows everything you've kept or skipped, and lets you change any decision.

To review on your phone, including with no connection, see [Phone setup with Tailscale](#phone-setup-with-tailscale).

**Settings and data**

Review mode's options are in Bridge's `settings.json` (on Windows, `%APPDATA%\Bridge\bridge_data\settings.json`). The two toggles are also in the Review tab.

| Setting | Default | Meaning |
|---|---|---|
| `reviewInstrument` / `reviewDifficulty` | `drums` / `expert` | Which charts are imported for review |
| `reviewClipSeconds` | `30` | Length of each clip |
| `reviewClipBuffer` | `600` | How many clips to keep ready (about 360 KB each) |
| `reviewAutoSync` | `true` | Check for new charts on startup and daily |
| `reviewAutoDownload` | `true` | Download songs as soon as you keep them |
| `reviewServerPort` | `47823` | Port of the phone app server (localhost only) |

Review data is stored next to the settings file: `review.db` (songs and your decisions), `review-clips/`, and `review-art/`.

### Phone setup with Tailscale

The phone app is a web app that Bridge serves from your PC. Phones only let a web app work offline when it's served over HTTPS, so Bridge uses [Tailscale](https://tailscale.com) (free for personal use) to give your PC a private HTTPS address. Only devices signed in to your Tailscale account can reach it, and it works both at home and away from home. Bridge's server itself only listens on `127.0.0.1`, so it is never exposed to your local network.

**One-time setup**

1. **Install Tailscale on your PC** from [tailscale.com/download](https://tailscale.com/download) and sign in.
2. **Install Tailscale on your phone** ([iPhone](https://apps.apple.com/app/tailscale/id1470499037) or [Android](https://play.google.com/store/apps/details?id=com.tailscale.ipn)) and sign in to the **same account**.
3. **Turn on HTTPS for your tailnet:** in the Tailscale admin console, open [DNS](https://login.tailscale.com/admin/dns), make sure **MagicDNS** is enabled, and click **Enable HTTPS**.
4. **Share Bridge with your phone:** open Bridge's **Review** tab and click **Set up phone access**. This runs:

   ```
   tailscale serve --bg 47823
   ```

   It only needs to be done once; Tailscale remembers it across restarts. If Tailscale replies with a link asking you to enable HTTPS, open the link, approve it, and click the button again.
5. **Open the app on your phone:** the Review tab shows your PC's address (like `https://my-pc.tailnet-name.ts.net`) and a QR code. Scan it with your phone's camera.
6. **Add it to your home screen:**
   - iPhone (Safari): tap **Share**, then **Add to Home Screen**.
   - Android (Chrome): tap **⋮**, then **Add to Home screen** or **Install app**.

**Daily use**

1. Open **Bridge Review** from your home screen.
2. Tap the sync button (top right), choose how many songs to keep on the phone (100–1000), and tap **Sync & download**. This needs Bridge to be open on your PC and Tailscale to be connected on the phone.
3. Review anywhere, even with no signal: swipe right or tap 👍 to keep, swipe left or tap 👎 to skip, **Later** to come back to a song, and the undo button to take back the last decision.
4. Your decisions are saved on the phone and sent to Bridge the next time the phone can reach your PC. The number on the sync button shows how many are waiting. When the phone runs low on songs and Bridge is reachable, it tops up automatically.

**Troubleshooting**

- **"Couldn't reach Bridge":** make sure Bridge is open on the PC and Tailscale shows *Connected* on both devices. Running `tailscale serve status` on the PC should list `https://<your-pc>...` proxying to `http://127.0.0.1:47823`.
- **"Bridge is still preparing more clips":** Bridge makes clips in the background; sync again in a few minutes.
- **To stop sharing Bridge with your phone:** run `tailscale serve reset` on the PC.

### Development notes for this fork

`npm start` also builds the phone app (`src-review-web/` → `dist/review-web/`), and the release builds include it. Clips are made with a bundled copy of ffmpeg ([ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)), so ffmpeg doesn't need to be installed. To rebuild only the phone app:

```
$ npm run build:review-web
```
