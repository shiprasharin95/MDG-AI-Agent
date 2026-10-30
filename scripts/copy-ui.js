/**
 * Copies the Fiori elements app into gen/srv so the CAP server serves it directly
 * (no separate HTML5 repository module needed).
 *   app/bpupload/webapp  ->  gen/srv/app/bpupload/webapp
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const src = path.join(root, 'app', 'bpupload', 'webapp')
const dest = path.join(root, 'gen', 'srv', 'app', 'bpupload', 'webapp')

if (!fs.existsSync(src)) {
  console.error('UI sources not found:', src)
  process.exit(1)
}
fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.cpSync(src, dest, { recursive: true })

// index.html at the app root -> redirect to the Fiori app
fs.writeFileSync(path.join(root, 'gen', 'srv', 'app', 'index.html'),
  '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/bpupload/webapp/index.html"></head><body></body></html>\n')

console.log('UI copied to', dest)
