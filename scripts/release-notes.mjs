// Prints the CHANGELOG.md section for the version in src-tauri/tauri.conf.json.
// The release workflow uses it as the GitHub Release body, which the in-app updater
// shows to users before they install.
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'))
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')

const lines = changelog.split('\n')
const start = lines.findIndex((l) => l.startsWith(`## ${version}`) || l.startsWith(`## [${version}]`))
if (start === -1) {
  console.log(`Forma Studio ${version}`)
  process.exit(0)
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
console.log(lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim())
