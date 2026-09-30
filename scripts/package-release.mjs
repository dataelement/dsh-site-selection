import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const assetName = 'dsh-site-selection.tgz'
const required = ['package.json', 'src/index.js', 'lib/client.js', 'cordis.patch.yml']
const temp = mkdtempSync(join(tmpdir(), 'dsh-site-selection-pack-'))

try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))
  if (packed.name !== manifest.name || packed.version !== manifest.version) throw new Error('Package identity changed during packing')
  const paths = new Set(packed.files.map((file) => file.path))
  for (const file of required) if (!paths.has(file)) throw new Error(`Release package is missing ${file}`)
  if (packed.size > 8 * 1024 * 1024) throw new Error('Release package exceeds the catalog 8 MiB download limit')
  if (packed.files.length > 500 || packed.files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) {
    throw new Error('Release package exceeds the catalog unpacked limits')
  }
  const source = join(temp, packed.filename)
  const entries = execFileSync('tar', ['-tzf', source], { encoding: 'utf8' }).trim().split('\n')
  if (entries.some((entry) => !entry.startsWith('package/') || entry.includes('..'))) throw new Error('Release package has an unsafe archive path')
  const destination = join(root, 'dist', assetName)
  mkdirSync(join(root, 'dist'), { recursive: true })
  copyFileSync(source, destination)
  const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex')
  console.log(`${destination}\nversion: ${packed.version}\nbytes: ${packed.size}\nsha256: ${sha256}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
