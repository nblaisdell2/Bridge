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
- ✅ Review mode: hear a short preview of every song and keep or skip it, on your PC or offline on your phone.

### Review mode

The **Review** tab imports every chart that has the review instrument and difficulty (Expert drums by default), groups the charts into songs, and prepares a 30 second clip of each song starting at its preview point. Only the part of each audio file around the preview is downloaded. Keep or skip songs on the PC with the built-in player, or on your phone:

1. Install [Tailscale](https://tailscale.com/download) on the PC and the phone, signed in to the same account.
2. In the Review tab, click **Set up phone access** (runs `tailscale serve --bg 47823`).
3. Open the PC's Tailscale address on the phone and choose **Add to Home Screen**.
4. Open the app and sync to download a batch of songs. Reviewing works with no connection; decisions are sent to Bridge the next time the phone can reach the PC.

Kept songs are downloaded into your default library folder using the best chart for each song (reviewed drums, pro drums, and fewest issues come first). Bridge checks Chorus for new charts on startup and once a day, and new songs are reviewed before the backlog.

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
