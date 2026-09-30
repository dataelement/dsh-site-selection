import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const RUNTIME_WORKBENCH_ID = 'wb-dataelement-dsh-site-selection'
const LEGACY_WORKBENCH_ID = 'site-selection'

async function client(storage = new Map(), { legacyService = false, sessionService = false, realSnapshot = false, publicCurrentSession = true } = {}) {
  const posts = []
  let plugin, registration, loaderId, current = 's1', draft = '已有草稿', pending, occurrences = []
  const effects = [], callbacks = [], frameWindow = {}
  const workbenchId = legacyService ? LEGACY_WORKBENCH_ID : RUNTIME_WORKBENCH_ID
  const state = { active: workbenchId, added: [workbenchId], sessionBindings: { s1: workbenchId, s2: workbenchId, other: 'another' } }
  const snapshot = () => realSnapshot
    ? { byId: Object.fromEntries(Object.keys(state.sessionBindings).map(id => [id, { retainedBy: { mainView: id === current ? 1 : 0 } }])) }
    : { current }
  const desktopWorkbenches = {
    state,
    subscribe: cb => { callbacks.push(cb); return () => {} },
    register: descriptor => { registration = descriptor; return () => {} },
  }
  if (realSnapshot && publicCurrentSession) desktopWorkbenches.currentSession = () =>
    Object.keys(snapshot().byId).find(id => snapshot().byId[id].retainedBy.mainView > 0)
  const ensured = []
  if (sessionService) desktopWorkbenches.ensureSession = async ({ folder }) => {
    ensured.push(folder)
    current = `new-${ensured.length}`
    state.sessionBindings[current] = workbenchId
    callbacks.forEach(cb => cb())
    return current
  }
  if (!legacyService) {
    desktopWorkbenches.isActive = () => state.active === workbenchId && state.added.includes(workbenchId)
    desktopWorkbenches.ownsSession = sessionId => desktopWorkbenches.isActive() && state.sessionBindings[sessionId] === workbenchId
  }
  const ctx = {
    effect: fn => effects.push(fn()),
    sessions: { list: { getSnapshot: snapshot, subscribe: cb => { callbacks.push(cb); return () => {} } }, scope: () => ({ get: () => ({ input: { for: () => ({ state: { getSnapshot: () => ({ draft, occurrences }) }, setDraft: value => { draft = value } }) } }) }) },
    desktopWorkbenches,
  }
  const origin = 'http://127.0.0.1:5197'
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { location: { origin }, __ModuleLoader__: { load: spec => { loaderId = spec.id; plugin = spec.factory(() => ({ createElement() {} })) } } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setInterval: () => 1, clearInterval() {},
    fetch: async (path, options) => {
      if (options) { posts.push({ path, body: JSON.parse(options.body) }); if (pending) await pending; return { ok: true, json: async () => ({}) } }
      if (path.includes('/bootstrap')) return { ok: true, json: async () => ({ folder: '/business/A', state: { project: { name: 'A' } } }) }
      return { ok: true, json: async () => ({ bindings: { s1: 'project-a', s2: 'project-b' } }) }
    },
  })
  plugin.apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  return { plugin, state, storage, posts, ensured, workbenchId, loaderId, registration: () => registration,
    frame: { contentWindow: frameWindow }, event: { origin, source: frameWindow, data: { project: 'project-a' } }, draft: () => draft, chips: (value = true) => { occurrences = value ? [{}] : [] },
    switch: id => { current = id; callbacks.forEach(cb => cb()) }, defer: promise => { pending = promise } }
}

test('declares the package loader, stable runtime id, and repository identity', async () => {
  const c = await client()
  assert.equal(c.loaderId, 'dsh-site-selection')
  assert.equal(c.plugin.RUNTIME_WORKBENCH_ID, RUNTIME_WORKBENCH_ID)
  assert.equal(c.plugin.LEGACY_WORKBENCH_ID, LEGACY_WORKBENCH_ID)
  assert.equal(c.registration().id, RUNTIME_WORKBENCH_ID)
  assert.equal(c.registration().repository, 'https://github.com/dataelement/dsh-site-selection')
})

test('retains old-host state compatibility while the market migrates site-selection', async () => {
  const c = await client(new Map(), { legacyService: true })
  assert.equal(c.plugin.acceptedMessage(c.event, c.frame, 's1', 'project-a'), true)
  c.state.active = 'another'
  assert.equal(c.plugin.acceptedMessage(c.event, c.frame, 's1', 'project-a'), false)
})

test('iframe bridge accepts only its own frame, origin, active owner and project', async () => {
  const c = await client(), check = e => c.plugin.acceptedMessage(e, c.frame, 's1', 'project-a')
  assert.equal(check(c.event), true)
  assert.equal(check({ ...c.event, source: {} }), false)
  assert.equal(check({ ...c.event, origin: 'https://evil.test' }), false)
  assert.equal(check({ ...c.event, data: { project: 'project-b' } }), false)
  c.state.active = 'another'
  assert.equal(check(c.event), false)
  c.state.active = RUNTIME_WORKBENCH_ID
  c.switch('other')
  assert.equal(check(c.event), false)
})

test('draft is appended only to the active workbench-owned session', async () => {
  const c = await client()
  c.plugin.fillDraft('s1', '选址内容')
  assert.equal(c.draft(), '已有草稿\n\n选址内容')
  c.switch('s2')
  assert.throws(() => c.plugin.fillDraft('s1', 'stale'), /切换/)
  assert.equal(c.draft(), '已有草稿\n\n选址内容')
})

test('native reference chips are preserved by refusing replacement', async () => {
  const c = await client()
  c.chips()
  assert.throws(() => c.plugin.fillDraft('s1', '选址内容'), /引用/)
  assert.equal(c.draft(), '已有草稿')
})

test('project selection cannot change the session after an async navigation race', async () => {
  const c = await client()
  let release
  c.defer(new Promise(resolve => { release = resolve }))
  const opened = c.plugin.openProject('project-c')
  c.switch('s2')
  release(); await opened
  const e = { ...c.event, data: { project: 'project-b' } }
  assert.equal(c.plugin.acceptedMessage(e, c.frame, 's2', 'project-b'), true)
  c.switch('s1')
  assert.equal(c.plugin.acceptedMessage({ ...e, data: { project: 'project-c' } }, c.frame, 's1', 'project-c'), true)
  c.switch('other')
  await c.plugin.openProject('project-a')
  assert.equal(c.plugin.businessMessage(c.event, c.frame, null, 'project-a'), true)
  assert.equal(c.plugin.acceptedMessage(c.event, c.frame, null, 'project-a'), false)
})

const root = await mkdtemp(join(tmpdir(), 'site-workbench-'))
process.env.DSH_SITE_SELECTION_ROOT = root
const host = await import('../src/index.js?workbench-test')
function request(url, method = 'GET', body, extraHeaders = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  Object.assign(req, { url, method, headers: { host: '127.0.0.1:5197', 'content-type': 'application/json', ...extraHeaders } })
  let status, data
  const res = { writeHead(code) { status = code }, end(bytes) { data = bytes?.toString() } }
  return host.handleApi(req, res).then(() => ({ status, data }))
}

test('many sessions share a business project with atomic persistent selections', async () => {
  await host.ensureProject('a', { name: 'A' }); await host.ensureProject('b', { name: 'B' })
  await Promise.all([host.selectSessionProject('s1', 'a'), host.selectSessionProject('s2', 'a')])
  assert.deepEqual(await host.readSessionProjects(), { s1: 'a', s2: 'a' })
  await host.selectSessionProject('s1', 'b')
  const fresh = await import('../src/index.js?fresh-workbench')
  assert.deepEqual(await fresh.readSessionProjects(), { s1: 'b', s2: 'a' })
  await assert.rejects(host.selectSessionProject('__proto__', 'a'), /Invalid/)
  await assert.rejects(host.selectSessionProject('s1', '../a'), /Invalid/)
})

test('host blocks cross-origin and non-JSON writes and symlink file escape', async () => {
  assert.equal((await request('/api/site-selection/projects', 'POST', { name: 'no' }, { origin: 'https://evil.test' })).status, 403)
  assert.equal((await request('/api/site-selection/projects', 'POST', { name: 'no' }, { 'content-type': 'text/plain' })).status, 415)
  const { folder } = await host.ensureProject('files', { name: 'Files' })
  const outside = join(root, 'outside.txt'); await writeFile(outside, 'private')
  await symlink(outside, join(folder, 'escape.txt'))
  assert.equal((await request('/api/site-selection/file?project=files&path=escape.txt')).status, 403)
})

test('every registered route uses connection authentication, including assets', async () => {
  const routes = []
  host.apply({ effect: fn => fn(), webServer: { register: route => { routes.push(route); return () => {} } }, connection: { requestRejection: () => 401 } })
  assert.ok(routes.some(r => r.path.endsWith('/app')))
  for (const route of routes) {
    let status
    await route.handler({}, { writeHead(code) { status = code }, end() {} })
    assert.equal(status, 401)
  }
})

test('business selection works without a session, survives reload and keeps session mappings', async () => {
  const c = await client(); c.switch(null)
  await c.plugin.openProject('project-free')
  const event = { ...c.event, data: { project: 'project-free' } }
  assert.equal(c.plugin.businessMessage(event, c.frame, null, 'project-free'), true)
  assert.equal(c.posts.length, 0)
  assert.equal(c.plugin.acceptedMessage(event, c.frame, null, 'project-free'), false)
  assert.throws(() => c.plugin.fillDraft(null, 'not allowed'), /切换/)
  c.state.sessionBindings.fresh = RUNTIME_WORKBENCH_ID; c.switch('fresh')
  assert.equal(c.plugin.acceptedMessage(event, c.frame, 'fresh', 'project-free'), true)
  assert.deepEqual(c.posts[0].body, { sessionId: 'fresh', project: 'project-free' })
  c.switch('s1')
  assert.equal(c.plugin.acceptedMessage(c.event, c.frame, 's1', 'project-a'), true)
  c.switch(null)
  assert.equal(c.plugin.businessMessage(event, c.frame, null, 'project-free'), true)
  const reloaded = await client(c.storage); reloaded.switch(null)
  assert.equal(reloaded.plugin.businessMessage({ ...reloaded.event, data: { project: 'project-free' } }, reloaded.frame, null, 'project-free'), true)
  reloaded.state.active = 'other'
  assert.equal(reloaded.plugin.businessMessage({ ...reloaded.event, data: { project: 'project-free' } }, reloaded.frame, null, 'project-free'), false)
})
test('business creation and iframe visibility do not require a native session', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const create = source.slice(source.indexOf('    const submitCreate ='), source.indexOf("    return h('section'"))
  assert.doesNotMatch(create, /ownedSession|sessionId/)
  assert.match(source, /display: key === frameKey \? 'block' : 'none'/)
})

test('onboarding queues without native session and restores a single draft delivery', async () => {
  const c = await client(); c.switch(null); await c.plugin.openProject('new-business')
  assert.equal(c.draft(), '已有草稿')
  const restored = await client(c.storage); restored.switch(null)
  restored.state.sessionBindings.new = RUNTIME_WORKBENCH_ID; restored.switch('new')
  assert.match(restored.draft(), /^已有草稿\n\n/)
  assert.match(restored.draft(), /先帮我选 10 个/)
  assert.equal(restored.draft().includes('\\n'), false)
  const once = restored.draft(); restored.plugin.flushInitialDraft()
  assert.equal(restored.draft(), once)
  const reloaded = await client(c.storage); reloaded.switch(null)
  reloaded.state.sessionBindings.new = RUNTIME_WORKBENCH_ID; reloaded.switch('new')
  assert.equal(reloaded.draft(), '已有草稿')
})
test('creating a project opens an owned native session and fills its composer once', async () => {
  const c = await client(new Map(), { sessionService: true })
  c.switch(null)
  await c.plugin.openProject('new-business', { createSession: true })
  assert.deepEqual(c.ensured, ['/business/A'])
  assert.deepEqual(c.posts.at(-1).body, { sessionId: 'new-1', project: 'new-business' })
  assert.match(c.draft(), /先帮我选 10 个/)
  const once = c.draft()
  c.plugin.flushInitialDraft()
  assert.equal(c.draft(), once)
})
test('real Desktop summary delivers the prompt after opening a new session', async () => {
  const c = await client(new Map(), { sessionService: true, realSnapshot: true })
  c.switch(null)
  assert.equal(c.plugin.flushInitialDraft(), false)
  await c.plugin.openProject('new-business', { createSession: true })
  assert.deepEqual(c.posts.at(-1).body, { sessionId: 'new-1', project: 'new-business' })
  assert.match(c.draft(), /先帮我选 10 个/)
  const once = c.draft()
  c.plugin.flushInitialDraft()
  assert.equal(c.draft(), once)
})
test('real Desktop summary works when public currentSession is unavailable', async () => {
  const c = await client(new Map(), { realSnapshot: true, publicCurrentSession: false })
  c.switch(null)
  await c.plugin.openProject('new-business')
  assert.equal(c.draft(), '已有草稿')
  c.state.sessionBindings.fresh = RUNTIME_WORKBENCH_ID
  c.switch('fresh')
  assert.match(c.draft(), /先帮我选 10 个/)
})
test('a missing session service retains the prompt for later delivery', async () => {
  const c = await client()
  c.switch(null)
  await c.plugin.openProject('new-business', { createSession: true })
  assert.equal(c.draft(), '已有草稿')
  c.state.sessionBindings.later = RUNTIME_WORKBENCH_ID
  c.switch('later')
  assert.match(c.draft(), /先帮我选 10 个/)
})
test('rich draft or hidden workbench retains initial request until its owner is ready', async () => {
  const c = await client(); c.chips(); await c.plugin.openProject('project-a')
  assert.equal(c.draft(), '已有草稿')
  c.state.active = 'other'; c.chips(false)
  assert.equal(c.plugin.flushInitialDraft(), false)
  c.state.active = RUNTIME_WORKBENCH_ID; assert.equal(c.plugin.flushInitialDraft(), true)
  assert.match(c.draft(), /按回车发送/)
})
