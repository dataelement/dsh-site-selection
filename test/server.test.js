import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = await mkdtemp(join(tmpdir(), 'dsh-site-selection-'))
process.env.DSH_SITE_SELECTION_ROOT = root
const { applyAction, ensureProject, migrate, slugify, STATUS_LABEL } = await import('../src/index.js')

test('slugify keeps CJK readable and cannot escape the data root', () => {
  assert.equal(slugify('静安示例项目'), '静安示例项目')
  assert.equal(slugify('Q2 拓展 2026'), 'q2-拓展-2026')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('...', 'fb'), 'fb')
})

test('a new project starts empty and creates its folder structure', async () => {
  const { folder, state, scores } = await ensureProject('q2-拓展', { name: 'Q2 拓展' })
  assert.equal(folder, join(root, 'q2-拓展'))
  assert.deepEqual(state.sites, [])
  assert.deepEqual(state.pois, [])
  assert.equal(state.stores, undefined, '自有门店模式已移除')
  assert.deepEqual(scores, {})
  assert.equal(state.districtModel, null, "没绑数据集就没有基线")
  const context = await readFile(join(folder, 'CONTEXT.md'), 'utf8')
  assert.match(context, /project\.json/)
  assert.match(context, /不要写评分或基线/, "CONTEXT.md 必须告诉 DSH 哪些字段是派生的")
  assert.match(context, /不要编造坐标/)
})

test('the ranking model is derived, never trusted from the file', async () => {
  const { state } = await ensureProject('derived-test', { name: 'x' })
  state.districtModel = { ready: true, sampleSize: 999, statements: ['伪造的结论'] }
  const again = await ensureProject('derived-test')
  assert.notEqual(again.state.districtModel?.sampleSize, 999, '文件里写的基线必须被重算覆盖')
})

test('navigation leaves no trace; review decisions are durable', async () => {
  const { state } = await ensureProject('log-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A 铺', lng: 121.44, lat: 31.22, area: 100 } })
  applyAction(state, { type: 'create-site', site: { name: 'B 铺', lng: 121.45, lat: 31.23, area: 100 } })
  const [a, b] = state.sites.map(s => s.id)

  // Selecting a card and ticking a compare box are navigation, not decisions —
  // v1 of the earlier workbench logged these and drowned the review record.
  assert.equal(applyAction(state, { type: 'select', id: a }), null)
  assert.equal(applyAction(state, { type: 'compare', ids: [a, b] }), null)

  assert.equal(applyAction(state, { type: 'site-status', id: a, status: 'tovisit' }).durable, true)
  assert.equal(applyAction(state, { type: 'update-site', id: a, patch: { rent: 30000 } }).durable, false,
    '改铺面资料不是评审决定，不该进决策记录')
})

test('the compare set can be built one tick at a time', async () => {
  const { state } = await ensureProject('cmp-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A' } })
  applyAction(state, { type: 'create-site', site: { name: 'B' } })
  const [a, b] = state.sites.map(s => s.id)

  // Storing a one-item selection has to work: rejecting it made the set
  // impossible to grow, because the user can only ever tick one box at a time.
  assert.equal(applyAction(state, { type: 'compare', ids: [a] }), null)
  assert.deepEqual(state.compareIds, [a])
  applyAction(state, { type: 'compare', ids: [a, b] })
  assert.deepEqual(state.compareIds, [a, b])

  applyAction(state, { type: 'compare', ids: [a, b, 'ghost'] })
  assert.deepEqual(state.compareIds, [a, b], '不存在的 id 被丢弃')
  applyAction(state, { type: 'compare', ids: [] })
  assert.deepEqual(state.compareIds, [])
})

test('a rejection must carry a reason; signing records the decision', async () => {
  const { state } = await ensureProject('decide-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A' } })
  const id = state.sites[0].id
  assert.throws(() => applyAction(state, { type: 'decide', id, result: 'rejected' }), /必须填写理由/)
  assert.throws(() => applyAction(state, { type: 'decide', id, result: '也许' }), /只能是签约或否决/)

  const log = applyAction(state, { type: 'decide', id, result: 'rejected', reasons: ['租金过高'], note: '谈不到 25% 以下' })
  assert.equal(log.durable, true)
  assert.equal(state.sites[0].status, 'rejected')
  assert.equal(state.sites[0].decision.reasons[0], '租金过高')
  assert.match(log.text, /否决/)
})

test('a field note flips the site into 已踩点 and cannot be empty', async () => {
  const { state } = await ensureProject('note-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A' } })
  const id = state.sites[0].id
  assert.throws(() => applyAction(state, { type: 'field-note', id, observation: '  ' }), /至少填写/)
  applyAction(state, { type: 'field-note', id, peakFlow: 320, observation: '午市排队到门口' })
  assert.equal(state.sites[0].status, 'visited')
  assert.equal(STATUS_LABEL[state.sites[0].status], '看过')
  assert.equal(state.sites[0].fieldNotes[0].peakFlow, 320)
})

test('backing out of a decision clears the record; final states need `decide`', async () => {
  const { state } = await ensureProject('undo-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A' } })
  const id = state.sites[0].id
  assert.equal(state.sites[0].status, 'tovisit', '新点位从待看开始，没有初筛')
  // Only `decide` may sign or reject: it is the one path that demands a reason.
  assert.throws(() => applyAction(state, { type: 'site-status', id, status: 'signed' }), /状态不合法/)
  assert.throws(() => applyAction(state, { type: 'site-status', id, status: 'screening' }), /状态不合法/)

  applyAction(state, { type: 'decide', id, result: 'signed' })
  assert.equal(state.sites[0].decision.result, 'signed')
  const log = applyAction(state, { type: 'site-status', id, status: 'review' })
  assert.equal(state.sites[0].status, 'review')
  assert.equal(state.sites[0].decision, null, '退回后不该还挂着一条已签约')
  assert.equal(log.durable, true)
  assert.match(log.text, /撤回已签约/)
})

test('project files written with the retired 待初筛 stage load as 待看', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-legacy-'))
  process.env.DSH_SITE_SELECTION_ROOT = dir
  const mod = await import(`../src/index.js?legacy=${Date.now()}`)
  const { folder } = await mod.ensureProject('旧文件', { name: '旧文件' })
  await writeFile(join(folder, 'project.json'), JSON.stringify({
    project: { name: '旧文件' },
    sites: [{ id: 'site-1', name: '铺', status: 'screening' }],
  }), 'utf8')
  const { state } = await mod.ensureProject('旧文件')
  assert.equal(state.sites[0].status, 'tovisit')
  assert.ok(!state.ignoredFields.some(f => f.startsWith('sites[].status =')), '旧状态是迁移，不是错误')
  process.env.DSH_SITE_SELECTION_ROOT = root
})

test('tri-state hard conditions round-trip as booleans and null', async () => {
  const { state } = await ensureProject('tri-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A' } })
  const id = state.sites[0].id
  assert.equal(state.sites[0].hasFlue, null, '未确认应当是 null，不是 false')
  applyAction(state, { type: 'update-site', id, patch: { hasFlue: false } })
  assert.equal(state.sites[0].hasFlue, false)
  applyAction(state, { type: 'update-site', id, patch: { hasFlue: null } })
  assert.equal(state.sites[0].hasFlue, null)
})

test('update-site cannot smuggle in notes or a decision', async () => {
  const { state } = await ensureProject('guard-test', { name: 'x' })
  applyAction(state, { type: 'create-site', site: { name: 'A' } })
  const id = state.sites[0].id
  applyAction(state, { type: 'field-note', id, observation: '真实记录' })
  applyAction(state, { type: 'update-site', id, patch: { fieldNotes: [], decision: { result: 'signed' }, rent: 30000 } })
  assert.equal(state.sites[0].fieldNotes.length, 1, '踩点记录不能被资料更新覆盖')
  assert.equal(state.sites[0].decision, null, '定案不能走资料更新的路径')
  assert.equal(state.sites[0].rent, 30000)
})

test('migrate repairs a hand-edited file rather than throwing', () => {
  const state = migrate({
    project: { name: '手改过的' },
    sites: [{ name: '没有 id 的点位', lng: '121.44', lat: '31.22', hasFlue: 'yes' }],
    stores: 'not an array',
    selectedId: 'ghost', compareIds: ['ghost'],
    pois: [{ kind: 'food', lng: 121.44, lat: 31.22 }, { kind: 'food' }],
  }, '/tmp/x', 'x')
  assert.match(state.sites[0].id, /^site-/)
  assert.equal(state.sites[0].lng, 121.44, '字符串坐标要被转成数字')
  assert.equal(state.sites[0].hasFlue, null, '非布尔值的硬性条件退回未确认')
  assert.equal(state.stores, undefined, '遗留的 stores 字段被清掉')
  assert.equal(state.pois.length, 1, '缺坐标的 POI 被丢弃')
  assert.equal(state.selectedId, state.sites[0].id)
  assert.deepEqual(state.compareIds, [])
})

test('import-sites accepts a batch and tags its source', async () => {
  const { state } = await ensureProject('import-test', { name: 'x' })
  const log = applyAction(state, { type: 'import-sites', sites: [
    { name: 'A', lng: 121.44, lat: 31.22 }, { name: 'B', lng: 121.45, lat: 31.23 },
  ] })
  assert.equal(state.sites.length, 2)
  assert.equal(state.sites[0].source, '批量导入')
  assert.match(log.text, /2 个/)
  assert.throws(() => applyAction(state, { type: 'import-sites', sites: [] }), /没有可导入/)
})

test('every API handler in the module is actually routed', async () => {
  // A handler with no matching register() call is dead code that answers
  // "unauthorized" — which is what happened to /market: the branch existed,
  // the route did not, and the UI silently hid the tab.
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  const handled = [...src.matchAll(/url\.pathname === '(\/api\/site-selection\/[^']+)'/g)].map(m => m[1])
  const block = src.slice(src.indexOf('const routes = ['), src.indexOf('for (const path of routes)'))
  const registered = new Set([...block.matchAll(/'(\/api\/site-selection\/[^']+)'/g)].map(m => m[1]))
  assert.ok(handled.length >= 8, `only found ${handled.length} handlers`)
  for (const path of handled) {
    assert.ok(registered.has(path), `${path} is handled but never registered`)
  }
})

test('a second project with the same name gets a distinguishable label', async () => {
  // The folder was always de-duplicated; the display name was not, so the picker
  // showed two identical rows and choosing the wrong one looked like data loss.
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /const label = slug === base \? name : `\$\{name\}（\$\{suffix - 1\}）`/,
    'project creation must derive a distinct display name when the slug collided')
  assert.match(src, /ensureProject\(slug, \{ name: label \}\)/,
    'the de-duplicated label must be the one actually stored')
})

test('askPrompt declares the buffer it appends to', async () => {
  // Every 交给 DSH button failed with "lines is not defined": askPrompt pushed
  // into `lines` from the first line but nothing ever created it.
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const fn = client.slice(client.indexOf('function askPrompt('), client.indexOf('// ── components'))
  assert.match(fn, /const lines = \[/, 'askPrompt must declare `lines` before pushing into it')
  assert.ok(fn.indexOf('const lines = [') < fn.indexOf('lines.push('), 'declared before first use')
})

test('the panel follows the active conversation instead of one global project', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /function projectForSession/,
    'a session must be resolvable back to its project')
  assert.match(client, /list\.getSnapshot\(\)\?\.current/,
    'the watcher must read the active session from sessions.list.current')
  // `selection` is the tempting one and it is wrong: it goes null mid-switch,
  // so a watcher built on it blanks the panel instead of following.
  assert.ok(!/sessions\?\.selection\?\.sessionId/.test(client),
    'sessions.selection must not be used as the active-session signal')
  // The guard is the point: an unrelated conversation must not blank the panel.
  assert.match(client, /if \(slug && slug !== openState\.project\) setOpen/,
    'only switch when the session maps to a project')
})

test('the conversation binding survives a restart because it lives in project.json', async () => {
  const { folder, state } = await ensureProject('绑定测试', { name: '绑定测试' })
  assert.equal(state.project.sessionId, '')

  assert.equal(applyAction(state, { type: 'bind-session', sessionId: 'session-abc123' }).text, '')
  assert.equal(state.project.sessionId, 'session-abc123')
  // Plumbing, not a decision — it must not show up in the activity log.
  assert.ok(!state.activity.some(a => /session-abc123/.test(a.text)))

  // Round-trip through disk. This is the whole point: the renderer's origin
  // changes with the port on every launch, so a binding kept in localStorage is
  // gone by the next restart and the panel can no longer follow the conversation.
  await writeFile(join(folder, 'project.json'), JSON.stringify(state, null, 2), 'utf8')
  const reread = await ensureProject('绑定测试')
  assert.equal(reread.state.project.sessionId, 'session-abc123')

  assert.throws(() => applyAction(state, { type: 'bind-session', sessionId: '' }), /不能为空/)
})

test('the action endpoint takes `project` in the body, and the client sends it there', async () => {
  // A mismatched call fails with 400 and, because the binding is best-effort,
  // fails silently — the panel simply never learns which conversation it is in.
  const server = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(server, /const slug = slugify\(action\.project \|\| ''\)/,
    'the endpoint reads project from the parsed body')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const call = client.slice(client.indexOf("type: 'bind-session'") - 400, client.indexOf("type: 'bind-session'") + 80)
  assert.match(call, /project: slug/, 'the bind-session call must carry project in the body')
  assert.ok(!/projectUrl\('\/api\/site-selection\/action'/.test(client),
    'the action endpoint must not be called with project in the query string')
})

test('on startup the panel resolves the project from the conversation already open', async () => {
  // Without this, the watcher latches the current session as its baseline and
  // never fires for it, so the panel starts blank even though the conversation
  // you are sitting in belongs to a project.
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const apply = client.slice(client.indexOf('bridge = { sessions:'))
  const seedAt = apply.indexOf('Object.assign(openState')
  const resolveAt = apply.indexOf('projectForSession(ctx.sessions?.list?.getSnapshot?.()?.current)')
  const watcherAt = apply.indexOf('follow the active conversation')
  assert.ok(seedAt >= 0 && resolveAt >= 0 && watcherAt >= 0, 'all three steps must be present')
  assert.ok(seedAt < resolveAt, 'openState must be seeded before anything resolves against it')
  assert.ok(resolveAt < watcherAt, 'the startup resolve must come before the watcher latches a baseline')
})

test('the district baseline is cached per format, not per city', async () => {
  // Competition is part of the baseline, and competition depends on the format.
  // Keying the cache on the dataset alone would hand a pharmacy project the
  // café baseline — and reading `project.format` inside a function that never
  // received `project` is how this was first written, which threw on every
  // bootstrap and left the panel stuck on "正在打开项目…".
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function districtModelFor'),
    src.indexOf('\n}', src.indexOf('async function districtModelFor')))
  assert.match(fn, /districtModelFor\(datasetName, format\)/, '必须显式接收 format')
  assert.match(fn, /\$\{datasetName\}::\$\{format/, '缓存键必须含 format')
  assert.ok(!/project\.format/.test(fn), 'districtModelFor 里没有 project 这个变量')
  assert.match(src, /districtModelFor\(state\.project\.dataset, state\.project\.format\)/,
    '调用方必须把 format 传进去')
})

test('fields the workbench discards are reported back to DSH', async () => {
  // DSH edits project.json directly and gets no error when a field is dropped,
  // so it reports success for a change that never landed. The only place it
  // will read the truth is CONTEXT.md, which is rewritten on every bootstrap.
  const dir = await mkdtemp(join(tmpdir(), 'ss-ignored-'))
  process.env.DSH_SITE_SELECTION_ROOT = dir
  const mod = await import(`../src/index.js?ignored=${Date.now()}`)
  const { folder } = await mod.ensureProject('回报测试', { name: '回报测试' })

  await writeFile(join(folder, 'project.json'), JSON.stringify({
    project: { name: '回报测试' },
    sites: [{ id: 'site-1', name: '铺', score: 91, tier: 'visit', notes: '随手写', status: '瞎填的' }],
  }), 'utf8')
  const { state } = await mod.ensureProject('回报测试')

  assert.ok(state.ignoredFields.includes('sites[].score'))
  assert.ok(state.ignoredFields.includes('sites[].notes'))
  assert.ok(state.ignoredFields.some(f => f.startsWith('sites[].status =')))
  // …and it must not leak into the file it describes.
  assert.ok(!Object.keys(state).includes('ignoredFields'))

  const context = await readFile(join(folder, 'CONTEXT.md'), 'utf8')
  assert.match(context, /被忽略的字段/)
  assert.match(context, /sites\[\]\.score/)
  assert.match(context, /不要告诉用户这些改动生效了/)
})

test('every delegated click target sits inside the element it is delegated from', async () => {
  // Moving a control to a different container silently breaks a delegated
  // handler: no error, the click just does nothing. Both the listings toggle
  // and the 铺源 radius chips were dead this way.
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')

  // `.stage` must contain the nav, the map view and the 铺源 view.
  const stage = html.slice(html.indexOf('<section class="stage">'), html.indexOf('</section>'))
  for (const needle of ['stage-nav', 'id="mapView"', 'id="marketView"']) {
    assert.ok(stage.includes(needle), `.stage 必须包含 ${needle}`)
  }
  const handler = js.slice(js.indexOf("document.querySelector('.stage').addEventListener"))
  assert.ok(handler.includes('#toggleListings'), '图层开关必须由 .stage 处理')
  assert.ok(handler.includes('[data-radius]'), '半径按钮必须由 .stage 处理')
  assert.ok(!/querySelector\('\.stage-nav'\)\.addEventListener/.test(js),
    '不能再把这些绑回 .stage-nav——控件已经不在里面了')
})

test('a unit is attached to the nearest location, and locations stay top level', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-tree-'))
  process.env.DSH_SITE_SELECTION_ROOT = dir
  const mod = await import(`../src/index.js?tree=${Date.now()}`)
  const { folder } = await mod.ensureProject('层级测试', { name: '层级测试' })

  // Written the way it looked before the two-level model existed: units with no
  // kind and no parent, sitting alongside the locations.
  await writeFile(join(folder, 'project.json'), JSON.stringify({
    project: { name: '层级测试' },
    sites: [
      { id: 'loc-a', name: 'A 位置', lng: 116.4500, lat: 39.9000 },
      { id: 'loc-b', name: 'B 位置', lng: 116.5000, lat: 39.9000 },
      { id: 'u-1', name: '铺 1', lng: 116.4502, lat: 39.9001, source: '铺源 lst-1' },
      { id: 'u-2', name: '铺 2', lng: 116.4998, lat: 39.9002, source: '铺源 lst-2' },
    ],
  }), 'utf8')
  const { state } = await mod.ensureProject('层级测试')
  const by = Object.fromEntries(state.sites.map(s => [s.id, s]))

  assert.equal(by['loc-a'].kind, 'location', '没有 kind 的默认是位置')
  assert.equal(by['loc-a'].parentId, '')
  // Units keep their own kind once set, and land under whichever location is closer.
  by['u-1'].kind = 'unit'; by['u-2'].kind = 'unit'
  await writeFile(join(folder, 'project.json'), JSON.stringify(state), 'utf8')
  const again = (await mod.ensureProject('层级测试')).state
  const map = Object.fromEntries(again.sites.map(s => [s.id, s]))
  assert.equal(map['u-1'].parentId, 'loc-a', '铺 1 应挂在更近的 A 下')
  assert.equal(map['u-2'].parentId, 'loc-b', '铺 2 应挂在更近的 B 下')
  assert.equal(map['loc-a'].parentId, '', '位置永远是顶层')
})

test('a unit whose parent disappeared is re-homed rather than orphaned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-reparent-'))
  process.env.DSH_SITE_SELECTION_ROOT = dir
  const mod = await import(`../src/index.js?reparent=${Date.now()}`)
  const { folder } = await mod.ensureProject('重挂测试', { name: '重挂测试' })
  await writeFile(join(folder, 'project.json'), JSON.stringify({
    project: { name: '重挂测试' },
    sites: [
      { id: 'loc-live', kind: 'location', name: '还在的位置', lng: 116.46, lat: 39.90 },
      // Points at a location the user has since deleted.
      { id: 'u-1', kind: 'unit', parentId: 'loc-gone', name: '铺', lng: 116.461, lat: 39.901 },
    ],
  }), 'utf8')
  const { state } = await mod.ensureProject('重挂测试')
  assert.equal(state.sites.find(s => s.id === 'u-1').parentId, 'loc-live')
})
