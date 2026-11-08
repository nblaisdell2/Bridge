// Copies the phone app's static files next to its compiled app.js (dist/review-web).
import { createHash } from 'crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const sourceDir = import.meta.dirname
const outDir = join(sourceDir, '..', 'dist', 'review-web')
const iconDir = join(sourceDir, '..', 'src-angular', 'assets', 'images', 'system', 'icons', 'png')

mkdirSync(outDir, { recursive: true })
for (const file of ['index.html', 'styles.css', 'manifest.webmanifest']) {
	cpSync(join(sourceDir, file), join(outDir, file))
}
cpSync(join(iconDir, '256x256.png'), join(outDir, 'icon-256.png'))
cpSync(join(iconDir, '512x512.png'), join(outDir, 'icon-512.png'))

// Browsers only update an installed app when its service worker changes, so stamp it with a hash of everything it serves
const hash = createHash('sha256')
for (const file of ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon-256.png', 'icon-512.png']) {
	hash.update(readFileSync(join(outDir, file)))
}
const serviceWorker = readFileSync(join(sourceDir, 'sw.js'), 'utf8')
writeFileSync(join(outDir, 'sw.js'), serviceWorker.replace('__SHELL_VERSION__', hash.digest('hex').slice(0, 16)))
