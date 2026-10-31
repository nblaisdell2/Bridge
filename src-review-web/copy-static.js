// Copies the phone app's static files next to its compiled app.js (dist/review-web).
import { cpSync, mkdirSync } from 'fs'
import { join } from 'path'

const sourceDir = import.meta.dirname
const outDir = join(sourceDir, '..', 'dist', 'review-web')
const iconDir = join(sourceDir, '..', 'src-angular', 'assets', 'images', 'system', 'icons', 'png')

mkdirSync(outDir, { recursive: true })
for (const file of ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest']) {
	cpSync(join(sourceDir, file), join(outDir, file))
}
cpSync(join(iconDir, '256x256.png'), join(outDir, 'icon-256.png'))
cpSync(join(iconDir, '512x512.png'), join(outDir, 'icon-512.png'))
