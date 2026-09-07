#!/usr/bin/env node
/**
 * Query the SIMULATED commercial layer: 在租铺源、实测客流、商场档次.
 *
 * Companion to query-sites.mjs. That tool answers "where should I look",
 * from real OpenStreetMap data. This one answers "what is actually available
 * there, at what rent, with how much footfall" — the questions the workbench
 * otherwise says out loud that it cannot answer.
 *
 * EVERY NUMBER THIS PRINTS IS SIMULATED. It is stamped on the header of every
 * run and on every record, because the one failure mode that would matter is a
 * user carrying one of these rents into a real negotiation.
 *
 *   node query-listings.mjs --fields
 *   node query-listings.mjs --near-sites --radius 300      # 项目里每个点位附近的铺源
 *   node query-listings.mjs --where "l.rentPerMonth < 40000 && l.areaSqm > 50 && l.hasFlue"
 *   node query-listings.mjs --near 三里屯 --radius 800 --sort rent
 *   node query-listings.mjs --footfall --near-sites        # 每个点位的实测客流
 *   node query-listings.mjs --malls --near-sites --radius 500
 *   node query-listings.mjs --adopt lst-0123              # 收进点位，字段自动填好
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { haversine } from '../src/model.js'
import { siteFromListing } from '../src/market.js'
import { DATASETS } from '../src/datasets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'src', 'data')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = name => argv.includes(`--${name}`)

const LISTING_FIELDS = [
  ['l.areaSqm', '建筑面积 ㎡', ''],
  ['l.rentPerMonth', '月租金 元', ''],
  ['l.rentPerSqmDay', '租金单价 元/㎡/天', '国内商铺的通用口径，跨面积可比'],
  ['l.transferFee', '转让费 元', '0 表示没有；带装修的餐饮铺一般都有'],
  ['l.propertyFeePerSqm', '物业费 元/㎡/月', ''],
  ['l.freeRentDays', '免租期 天', '装修期，谈判的主要筹码之一'],
  ['l.leaseYears / l.increaseRatePct', '租期 年 / 年递增 %', ''],
  ['l.floor', '楼层', '1=首层，-1=地下一层。二层以上进店率通常掉一半以上'],
  ['l.frontageM', '临街面宽 m', '商场内铺为 null'],
  ['l.ceilingM', '净层高 m', ''],
  ['l.powerKw', '报装电容量 kW', ''],
  ['l.hasFlue / l.hasWater / l.canLicense', '排烟 / 上下水 / 可办食品经营许可', '布尔值，一票否决项'],
  ['l.hasGas', '市政燃气', '茶饮咖啡用不上；正餐火锅必须有。商场新铺多数禁明火'],
  ['l.independentDoor', '独立门头', ''],
  ['l.formerUse', '前身业态', "'餐饮（正餐）'|'奶茶咖啡'|'服装零售'|'空置（毛坯）'…"],
  ['l.vacantMonths', '已空置 月', '空得越久越好谈'],
  ['l.inMall / l.mallTier', '是否商场内铺 / 所在商场档次', "mallTier: '高端'|'中高端'|'大众'|'社区'，街铺为 null"],
  ['l.status', '状态', "'在租'|'已租出'|'已下架'"],
  ['l.channel / l.agent', '渠道 / 联系方', ''],
  ['l.postedDaysAgo', '挂牌天数', ''],
  ['d', '到最近点位的距离 m', '只在 --near-sites 时有值'],
]

const FOOTFALL_FIELDS = [
  ['c.daily / c.weekday / c.weekend', '日均 / 工作日 / 周末客流 人次', '250m 网格'],
  ['c.peaks', '高峰时段', "['12:00','18:30']"],
  ['c.mix', '客流构成 %', '{resident 常住, worker 办公, passing 过路}'],
  ['c.dwellMin', '平均停留 分钟', ''],
  ['c.avgTicket', '分品类客单价 元', '{咖啡, 茶饮, 快餐, 烘焙, 正餐}'],
]

const MALL_FIELDS = [
  ['m.tier', '档次', "'高端'|'中高端'|'大众'|'社区'"],
  ['m.openedYear / m.gfaSqm', '开业年份 / 总建面 ㎡', ''],
  ['m.dailyFootfall', '日均客流 人次', ''],
  ['m.vacancyRate', '空置率 0–1', '高于 0.15 要问清楚为什么'],
  ['m.rentPerSqmDay', '租金区间 [低, 高] 元/㎡/天', ''],
  ['m.teaCoffeeBrands', '现有茶饮咖啡品牌数', '同业密度'],
  ['m.anchorCategories / m.foodCourtFloors', '主力业态 / 餐饮楼层', ''],
]

if (has('fields')) {
  console.log('铺源 / 客流 / 商场档次查询。字段口径对齐国内数据商实际售卖的内容，')
  console.log('接入持牌数据源后按同一 schema 替换即可。\n')
  console.log('铺源 listings（l）：')
  for (const [k, label, note] of LISTING_FIELDS) console.log(`  ${k.padEnd(38)} ${label}${note ? `　—— ${note}` : ''}`)
  console.log('\n客流网格 footfall（c，加 --footfall）：')
  for (const [k, label, note] of FOOTFALL_FIELDS) console.log(`  ${k.padEnd(38)} ${label}${note ? `　—— ${note}` : ''}`)
  console.log('\n商场 malls（m，加 --malls）：')
  for (const [k, label, note] of MALL_FIELDS) console.log(`  ${k.padEnd(38)} ${label}${note ? `　—— ${note}` : ''}`)
  console.log('\n示例：')
  console.log('  --near-sites --radius 300                              每个点位附近在租的铺')
  console.log('  --near-sites --where "l.hasFlue && l.rentPerMonth < 35000"')
  console.log('  --where "l.formerUse.includes(\'奶茶\') && l.vacantMonths > 6"   前身同业、空置久＝好谈')
  console.log('  --footfall --near-sites                               每个点位的客流和客单价')
  console.log('  --malls --near-sites --radius 500                     附近商场的档次和空置率')
  console.log('  --adopt lst-0123                                      收进点位清单，字段自动填好')

  process.exit(0)
}

const projectDir = resolve(flag('project', process.cwd()))
const statePath = join(projectDir, 'project.json')
let state
try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch {
  console.error(`读不到 ${statePath}。请在项目文件夹里运行，或用 --project <路径> 指定。`)
  process.exit(1)
}
const spec = DATASETS[state.project?.dataset]
if (!spec?.market) { console.error('这个项目的城市还没有生成模拟商业数据。'); process.exit(1) }

const market = JSON.parse(await readFile(join(DATA, spec.market), 'utf8'))
const poiDoc = JSON.parse(await readFile(join(DATA, spec.poi), 'utf8'))
const places = poiDoc.places || []

const radius = Number(flag('radius', 400))
const limit = Number(flag('limit', 25))
const sortKey = flag('sort', 'distance')
const whereSrc = flag('where', null)
const nearArg = flag('near', null)
const adoptId = flag('adopt', null)
const asJson = has('json')
const wantFootfall = has('footfall')
const wantMalls = has('malls')
const nearSites = has('near-sites')
// A rejected site is one the user walked and turned down; re-listing its
// neighbourhood on the next round is exactly the loop they wanted to avoid.
const liveSites = (state.sites || []).filter(s =>
  Number.isFinite(s.lng) && !['rejected'].includes(s.status))

const banner = () => { console.log(`${market.label}　铺源库\n`) }

// ── --adopt: turn a listing into a candidate site ────────
if (adoptId) {
  const l = market.listings.find(x => x.id === adoptId)
  if (!l) { console.error(`找不到铺源 ${adoptId}`); process.exit(1) }
  const now = new Date().toISOString()
  // Attach to the nearest saved location: a unit belongs under the position it
  // sits in, not alongside it.
  const locations = (state.sites || []).filter(s => s.kind !== 'unit' && Number.isFinite(s.lng))
  let parent = null
  for (const loc of locations) {
    const d = haversine(loc, l)
    if (!parent || d < parent.d) parent = { d, loc }
  }
  // The mapping lives in src/market.js so a test can assert it answers every
  // FIELD_CHECKS question — see the note there.
  const site = siteFromListing(l, now, parent?.loc.id || '')
  const dup = (state.sites || []).find(s => s.source === site.source)
  if (dup) { console.log(`铺源 ${l.id} 已经收过了（${dup.name}）。`); process.exit(0) }
  state.sites = [...(state.sites || []), site]
  state.activity = [{ id: randomUUID(), at: now,
    text: `收入模拟铺源 ${l.id}：${l.address}，${l.areaSqm}㎡，月租 ${l.rentPerMonth} 元` },
    ...(state.activity || [])].slice(0, 200)
  const tmp = `${statePath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, statePath)
  console.log(parent
    ? `已收入「${parent.loc.name}」下的铺源：${site.name}（相距 ${Math.round(parent.d)}m）`
    : `已收入铺源：${site.name}（项目里还没有候选位置，暂时挂在顶层）`)
  console.log(`  面积 ${l.areaSqm}㎡　月租 ${l.rentPerMonth} 元　${l.rentPerSqmDay} 元/㎡/天　转让费 ${l.transferFee}`)
  console.log(`  排烟 ${l.hasFlue ? '有' : '无'}　上下水 ${l.hasWater ? '有' : '无'}　可办证 ${l.canLicense ? '是' : '否'}`
    + `　燃气 ${l.hasGas ? '有' : '无'}`)
  console.log('  ⚠ 这些字段来自模拟数据，界面上的「还需要补的」会因此变短——真实项目里要现场核实。')
  process.exit(0)
}

// ── target points ────────────────────────────────────────
let targets = []
if (nearSites) {
  if (!liveSites.length) { console.error('项目里还没有点位（或都被否决了）。先用 query-sites.mjs 找点位。'); process.exit(1) }
  targets = liveSites.map(s => ({ lng: s.lng, lat: s.lat, name: s.name, id: s.id }))
} else if (nearArg) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(nearArg.trim())
  if (m) targets = [{ lng: Number(m[1]), lat: Number(m[2]), name: nearArg }]
  else {
    const hit = places.find(p => p.name === nearArg) || places.find(p => p.name?.includes(nearArg))
      || poiDoc.pois.find(p => p.name === nearArg) || poiDoc.pois.find(p => p.name?.includes(nearArg))
    if (!hit) { console.error(`数据里找不到「${nearArg}」。`); process.exit(1) }
    targets = [{ lng: hit.lng, lat: hit.lat, name: hit.name }]
  }
}

const compile = (src, varName) => {
  if (!src) return null
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(varName, 'd', `return (${src})`)
    return (row, d) => { try { return !!fn(row, d) } catch { return false } }
  } catch (error) {
    console.error(`--where 表达式有语法错误：${error.message}`)
    process.exit(1)
  }
}

const nearestTarget = row => targets.reduce((best, t) => {
  const d = haversine(t, row)
  return !best || d < best.d ? { d, t } : best
}, null)

function collect(rows, varName) {
  const where = compile(whereSrc, varName)
  const out = []
  for (const row of rows) {
    let d = null, t = null
    if (targets.length) {
      const hit = nearestTarget(row)
      if (!hit || hit.d > radius) continue
      d = Math.round(hit.d); t = hit.t
    }
    if (where && !where(row, d)) continue
    out.push({ ...row, d, target: t?.name || '' })
  }
  return out
}

// ── footfall ─────────────────────────────────────────────
if (wantFootfall) {
  const rows = collect(market.footfall, 'c')
  rows.sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || b.daily - a.daily)
  const hits = rows.slice(0, limit)
  if (asJson) { console.log(JSON.stringify({ simulated: true, vendors: market.vendors.footfall, hits }, null, 2)); process.exit(0) }
  banner()
  console.log(`客流网格（250m）：命中 ${rows.length} 个，显示 ${hits.length} 个`)
  for (const c of hits) {
    console.log(`\n  ${c.target ? `${c.target}　` : ''}${c.d === null ? '' : `${c.d}m　`}${c.lng.toFixed(5)}, ${c.lat.toFixed(5)}`)
    console.log(`    日均 ${c.daily} 人次（工作日 ${c.weekday} / 周末 ${c.weekend}）　停留 ${c.dwellMin} 分钟`)
    console.log(`    构成：常住 ${c.mix.resident}% / 办公 ${c.mix.worker}% / 过路 ${c.mix.passing}%　高峰 ${c.peaks.join('、')}`)
    console.log(`    客单价：${Object.entries(c.avgTicket).map(([k, v]) => `${k} ${v}`).join('　')}`)
  }
  process.exit(0)
}

// ── malls ────────────────────────────────────────────────
if (wantMalls) {
  const rows = collect(market.malls, 'm')
  rows.sort((a, b) => (a.d ?? 0) - (b.d ?? 0))
  const hits = rows.slice(0, limit)
  if (asJson) { console.log(JSON.stringify({ simulated: true, vendors: market.vendors.malls, hits }, null, 2)); process.exit(0) }
  banner()
  console.log(`商场：命中 ${rows.length} 个，显示 ${hits.length} 个`)
  for (const m of hits) {
    console.log(`\n  ${m.name}　${m.tier}　${m.openedYear} 年开业　${(m.gfaSqm / 1e4).toFixed(1)} 万㎡`
      + `${m.d === null ? '' : `　距${m.target} ${m.d}m`}`)
    console.log(`    日均客流 ${m.dailyFootfall} 人次　空置率 ${(m.vacancyRate * 100).toFixed(1)}%`
      + `　租金 ${m.rentPerSqmDay[0]}–${m.rentPerSqmDay[1]} 元/㎡/天`)
    console.log(`    主力业态 ${m.anchorCategories.join('、')}　餐饮层 ${m.foodCourtFloors.join('、')}`
      + `　已有茶饮咖啡 ${m.teaCoffeeBrands} 家`)
  }
  process.exit(0)
}

// ── listings (default) ───────────────────────────────────
const onlyAvailable = !has('all-status')
let rows = collect(market.listings, 'l')
if (onlyAvailable) rows = rows.filter(l => l.status === '在租')

const SORTS = {
  distance: (a, b) => (a.d ?? 0) - (b.d ?? 0),
  rent: (a, b) => a.rentPerMonth - b.rentPerMonth,
  unit: (a, b) => a.rentPerSqmDay - b.rentPerSqmDay,
  area: (a, b) => b.areaSqm - a.areaSqm,
  vacant: (a, b) => b.vacantMonths - a.vacantMonths,
}
rows.sort(SORTS[sortKey] || SORTS.distance)
const hits = rows.slice(0, limit)

if (asJson) {
  console.log(JSON.stringify({ simulated: true, warning: market.warning,
    vendors: market.vendors.listings, matched: rows.length, hits }, null, 2))
  process.exit(0)
}

banner()
console.log(`铺源：命中 ${rows.length} 个${onlyAvailable ? '（仅在租）' : ''}，显示 ${hits.length} 个`
  + `${targets.length ? `　范围：${nearSites ? `${targets.length} 个点位` : targets[0].name} ${radius}m 内` : ''}`)
if (!hits.length) {
  console.log('\n没有符合条件的铺源。放宽半径或条件再试，并告诉用户你放宽了哪一条。')
  process.exit(0)
}
for (const l of hits) {
  const gate = [l.hasFlue ? null : '无排烟', l.hasWater ? null : '无上下水', l.canLicense ? null : '办不出证']
    .filter(Boolean)
  console.log(`\n  ${l.id}　${l.address}`)
  console.log(`    ${l.areaSqm}㎡　${l.floor === 1 ? '首层' : l.floor === -1 ? '地下一层' : `${l.floor} 层`}`
    + `${l.inMall ? `（${l.mallTier || '商场'}商场内）` : ''}　月租 ${l.rentPerMonth} 元（${l.rentPerSqmDay} 元/㎡/天）`
    + `　转让费 ${l.transferFee ? l.transferFee : '无'}`)
  console.log(`    前身 ${l.formerUse}　空置 ${l.vacantMonths} 个月　免租 ${l.freeRentDays} 天`
    + `　租期 ${l.leaseYears} 年递增 ${l.increaseRatePct}%`)
  console.log(`    ${l.frontageM === null ? '面宽 —' : `面宽 ${l.frontageM}m`}　层高 ${l.ceilingM}m　电 ${l.powerKw}kW`
    + `　燃气 ${l.hasGas ? '有' : '无'}`
    + `　${gate.length ? `⚠ ${gate.join('、')}` : '排烟/上下水/证 齐全'}`)
  if (l.d !== null) console.log(`    距「${l.target}」${l.d}m　${l.channel}　${l.agent}　挂牌 ${l.postedDaysAgo} 天`)
}
console.log('\n收进点位清单：node query-listings.mjs --adopt <铺源id>')
