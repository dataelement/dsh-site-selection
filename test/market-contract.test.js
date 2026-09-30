import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const runtimeId = 'wb-dataelement-dsh-site-selection'
const repository = 'https://github.com/dataelement/dsh-site-selection'
const screenshots = ['site-map.png', 'site-detail.png', 'site-reference.png']

test('source metadata and runtime registration share one stable workbench identity', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const legacy = JSON.parse(await readFile(new URL('workbench.json', root), 'utf8'))
  const client = await readFile(new URL('lib/client.js', root), 'utf8')
  const market = await readFile(new URL('docs/market-entry.yml', root), 'utf8')

  assert.equal(pkg.name, 'dsh-site-selection')
  assert.equal(pkg.version, '1.2.1')
  assert.equal(pkg.repository.url, `git+${repository}.git`)
  assert.equal(legacy.id, runtimeId)
  assert.deepEqual(legacy.legacyWorkbenchIds, ['site-selection'])
  assert.equal(legacy.version, pkg.version)
  assert.match(client, /__ModuleLoader__\.load\(\{ id: 'dsh-site-selection'/)
  assert.match(client, new RegExp(`const RUNTIME_WORKBENCH_ID = '${runtimeId}'`))
  assert.match(client, new RegExp(`repository: '${repository}'`))
  assert.match(market, new RegExp(`^url: ${repository}$`, 'm'))
  assert.match(market, new RegExp(`^workbenchId: ${runtimeId}$`, 'm'))
  assert.match(market, /^legacyWorkbenchIds:\n  - site-selection$/m)
})

test('market screenshots are genuine bounded PNG files from the source repository', async () => {
  for (const name of screenshots) {
    const bytes = await readFile(new URL(`docs/screenshots/${name}`, root))
    assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024)
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    assert.equal(width, 1440)
    assert.equal(height, 900)
    assert.ok(width * height <= 16 * 1024 * 1024)
  }
})
