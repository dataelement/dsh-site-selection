#!/usr/bin/env node
/**
 * Query the workbench's data for locations matching arbitrary requirements.
 *
 * This is the tool the DSH conversation drives. The user says what they want in
 * their own words — "地铁 200 米以内、周边餐饮多、在商场里" — and DSH turns that
 * into a `--where` expression over the feature vocabulary. There is deliberately
 * no fixed set of filters here: a scoring threshold is only one possible
 * predicate among many, and hard-coding a score slider made the tool narrower
 * than the questions people actually ask.
 *
 *   node query-sites.mjs --fields                      # what can be filtered on
 *   node query-sites.mjs --where "f.metroDist < 200 && f.food500 > 30"
 *   node query-sites.mjs --where "f.districtType === '商场'" --near 三里屯 --radius 2000
 *   node query-sites.mjs --where "s >= 80" --limit 20 --write
 *
 * Run from inside the project folder (the bound session's cwd already is).
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  fitDistrictModel, fitReferenceModel, findHighScoring, benchFeatures,
  indexPois, indexFloorGrid, indexBasemap, haversine,
} from '../src/model.js'
import { DATASETS } from '../src/datasets.js'
import { brandSplit } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'src', 'data')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = name => argv.includes(`--${name}`)

// ── the vocabulary a --where expression may use ──
const FIELDS = [
  ['f.score / s', '综合分 0–100', '这个位置在基线里的百分位平均'],
  ['f.metroDist', '最近地铁出入口距离 m', '越小越近'],
  ['f.metroExit300', '300m 内地铁出入口数', ''],
  ['f.floorArea500', '500m 内建筑面积 ㎡', '真实轮廓×层数算出，代表这块地的人的总量'],
  ['f.floorArea300', '300m 内建筑面积 ㎡', ''],
  ['f.food500 / f.food300', '餐饮数量', '正餐+快餐+咖啡+茶饮+烘焙+酒吧+甜品 合计，代表商业活跃度'],
  ['f.rivals500 / f.rivals300', '同类店数量', '按项目业态算——开药店就数药店。旧名 f.cafe500 仍可用'],
  ['f.rival500', '同业态竞品数', '需在项目里配置竞品品牌名单'],
  ['f.office500 / f.office300', '办公点数', '日间人口代理，OSM 覆盖偏稀疏'],
  ['f.residential800', '住宅楼数', '夜间人口代理'],
  ['f.supermarket500', '500m 内超市数', ''],
  ['f.school800', '800m 内中小学数', ''],
  ['f.campus1500', '1.5km 内大学数', ''],
  ['f.hospital800', '800m 内医院数', ''],
  ['f.mall300', '300m 内商场数', ''],
  ['f.mallDist / f.mallName', '最近商场距离与名称', ''],
  ['f.brandDist / f.brandName', '最近参照品牌门店', '仅在项目设了参照品牌时有值'],
  ['f.districtType', '商圈类型', "'商场' | '写字楼' | '社区' | '混合街铺'"],

  // ── 可达性：地铁之外的部分 ──
  ['f.busStop300 / f.busStop500', '公交站数', '公交覆盖的客群和地铁往往不重叠'],
  ['f.crossing150', '150m 内过街设施数', '斑马线/天桥/地道。过不了街，对面的人流就不是你的客流'],
  ['f.parking300', '300m 内停车场数', '开车来的客群能不能停下'],

  // ── 位置本身 ──
  ['f.roadName / f.roadClass', '临街道路名与等级', "roadClass: 'expy'|'major'|'minor'|'local'|'link'"],
  ['f.roadDist', '到最近道路中心线距离 m', '大于 60m 基本属于内街/退线位置'],
  ['f.streetLinks', '120m 内道路数', '≥2 代表多条路在附近汇合；不等于拐角位，那要现场看'],
  ['f.streetLength500', '500m 内街道总长 m', '街区密度，不含快速路。越大越好走'],
  ['f.severingDist', '到最近快速路距离 m', '小于 120m 说明被高架/快速路切断，对面客流过不来'],
  ['f.landuse', '所在地块用地性质', "'commercial'|'residential'|'park'|... 国内 OSM 覆盖不全，null 很常见"],

  // ── 客群结构（不计分，只画像）──
  ['f.customerMix.shares', '客群占比 %', '{worker, resident, student, visitor}'],
  ['f.customerMix.dominant.label', '主导客群', "'上班族'|'居民'|'学生'|'外来客流'"],
  ['f.customerMix.dayNight', '日夜人口比 0–100', '越高越偏写字楼，越低越偏居住'],
  ['f.residential500 / f.school500 / f.hotel500', '构成客群的原始计数', '同一半径，占比才可比'],

  ['p.<指标>', '各项百分位 0–100', "p.floorArea500 / p.metroDist / p.busStop300 / p.streetLinks ..."],
  ['g.demand / g.access / g.pitch', '三个维度各自的分数 0–100', '总分是这三个的平均，不是所有指标的平均'],
  ['n.name / n.kind / n.cat', '候选地点本身的名称与类别', ''],
]

const NOT_AVAILABLE = [
  ['实测人流量', '公开数据里没有。可用 f.floorArea500（建筑面积）和 f.food500（餐饮密度）作代理，或让用户踩点实测后填进 fieldNotes。'],
  ['商场档次 / 风格 / 品牌组合', '数据里只有商场名称和位置。可以先用 f.mallName 查出是哪个商场，再自己去查它的定位。'],
  ['租金', '数据里没有。铺源租金要用户或中介提供，填进点位的 rent 字段。'],
  ['消费力 / 收入水平', 'f.customerMix 只能告诉你客群「是谁」（上班族/居民/学生/过路客），说不出他们「花多少钱」。不要拿构成占比推消费力。'],
  ['是不是拐角位 / 独立门头', 'f.streetLinks 只说有几条路在 120m 内汇合，不等于这个铺开在拐角。要现场看或问房东。'],
  ['临街面宽 / 层高 / 楼层 / 排烟 / 上下水 / 电力容量',
    '属于具体铺面，不是位置属性，数据里一定没有。逐个补到点位字段里（frontage / ceilingM / floor / hasFlue / hasWater / powerKw），补一个界面上「还需要补的」就少一条。'],
]

if (has('fields')) {
  console.log('可用于 --where 的字段（f = 特征，p = 百分位，s = 综合分，n = 地点本身）：\n')
  for (const [k, label, note] of FIELDS) console.log(`  ${k.padEnd(28)} ${label}${note ? `　—— ${note}` : ''}`)
  console.log('\n数据里没有、不要假装能查的东西：\n')
  for (const [k, why] of NOT_AVAILABLE) console.log(`  ${k}\n      ${why}`)
  console.log('\n示例：')
  console.log(`  --where "f.metroDist < 200 && f.food500 > 30"`)
  console.log(`  --where "f.districtType === '商场' && p.floorArea500 > 70"`)
  console.log(`  --where "s >= 80 && f.rivals500 < 5"      # 分高但同业竞争少`)
  console.log(`  --where "f.campus1500 > 0 && f.metroDist < 400"   # 大学旁 + 地铁近`)
  console.log(`  --where "f.busStop300 >= 4 && f.crossing150 > 0"  # 公交好 + 过得了街`)
  console.log(`  --where "f.streetLinks >= 3 && f.roadDist < 40"   # 多条路汇合且直接临街`)
  console.log(`  --where "f.customerMix.dayNight < 35 && s >= 60"  # 居住盘，晚市生意`)
  console.log(`  --where "g.access >= 70 && g.pitch >= 60"         # 可达性和位置质量都过关`)
  process.exit(0)
}

const projectDir = resolve(flag('project', process.cwd()))
const limit = Number(flag('limit', 20))
const spacing = Number(flag('spacing', 250))
const minScore = Number(flag('min', 0))
const sortKey = flag('sort', 'score')
const whereSrc = flag('where', null)
const nearArg = flag('near', null)
const radius = Number(flag('radius', 1500))
const write = has('write')
const asJson = has('json')

const statePath = join(projectDir, 'project.json')
let state
try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch {
  console.error(`读不到 ${statePath}。请在项目文件夹里运行，或用 --project <路径> 指定。`)
  process.exit(1)
}
const spec = DATASETS[state.project?.dataset]
if (!spec) { console.error(`项目没有绑定城市数据集。`); process.exit(1) }

const poiDoc = JSON.parse(await readFile(join(DATA, spec.poi), 'utf8'))
const pois = poiDoc.pois
const places = poiDoc.places || []
const floorGrid = spec.floorArea ? indexFloorGrid(JSON.parse(await readFile(join(DATA, spec.floorArea), 'utf8'))) : null
const index = indexPois(pois)
// The same context the workbench builds, so a location scored here and the same
// location clicked in the UI give the same number.
const baseDoc = spec.basemap ? JSON.parse(await readFile(join(DATA, spec.basemap), 'utf8')) : null
const basemapIndex = baseDoc ? indexBasemap({ areas: baseDoc.areas, roads: baseDoc.roads }) : null
const availableKinds = new Set(pois.map(p => p.kind))
const format = state.project?.format || ''

// --near accepts "lng,lat" or a place name from the dataset
let near = null
if (nearArg) {
  if (/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(nearArg)) {
    const [lng, lat] = nearArg.split(',').map(Number)
    near = { lng, lat, name: nearArg }
  } else {
    const hit = [...places, ...pois].find(p => p.name && p.name.includes(nearArg))
    if (!hit) { console.error(`找不到地点「${nearArg}」。可以直接给坐标 --near 116.455,39.937`); process.exit(1) }
    near = { lng: hit.lng, lat: hit.lat, name: hit.name }
  }
}

const brand = state.project.referenceBrand
let model
if (brand) {
  // Same rule the server uses: search inside the project's own format, widen to
  // all retail if the brand is not tagged there.
  const { brandPoints, background, widened } = brandSplit(pois, brand, format)
  if (widened) console.error(`（「${brand}」在${format || '本业态'}里没找到，已放宽到全部零售业态匹配）`)
  model = fitReferenceModel(brandPoints, background, pois,
    { brandLabel: brand, floorGrid, index, basemapIndex, availableKinds, format, brandPoints })
}
if (!model?.ready) model = fitDistrictModel(pois, { index, floorGrid, basemapIndex, availableKinds, format,
  districtLabel: spec.label.split(' · ').pop() })
if (!model.ready) { console.error(`无法建立评分基线：${model.reason}`); process.exit(1) }

let where = null
if (whereSrc) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('f', 'p', 's', 'n', 'g', `return (${whereSrc})`)
    // `grp` is the fifth argument — the per-dimension scores. Forgetting to
    // forward it made every `g.access` in a --where silently undefined, so the
    // expression quietly matched nothing instead of failing loudly.
    where = (features, pct, score, point, grp) => {
      try { return !!fn(features, pct, score, point, grp) } catch { return false }
    }
  } catch (error) {
    console.error(`--where 表达式有语法错误：${error.message}`)
    console.error('用 --fields 看可用字段和示例。')
    process.exit(1)
  }
}

const result = findHighScoring(pois, model, {
  index, floorGrid, basemapIndex, availableKinds, format,
  minScore, limit: 500, spacing, onlyNamed: true, where, near, radius,
})
const SORTS = {
  score: (a, b) => b.score - a.score,
  metro: (a, b) => (a.features.metroDist ?? 9e9) - (b.features.metroDist ?? 9e9),
  food: (a, b) => b.features.food500 - a.features.food500,
  floor: (a, b) => (b.features.floorArea500 ?? 0) - (a.features.floorArea500 ?? 0),
  cafe: (a, b) => a.features.rivals500 - b.features.rivals500,
}
const hits = result.hits.sort(SORTS[sortKey] || SORTS.score).slice(0, limit)

if (asJson) {
  console.log(JSON.stringify({ baseline: { label: model.brandLabel, sampleSize: model.sampleSize, kind: model.kind },
    query: { where: whereSrc, near: near?.name, radius: near ? radius : null, minScore, sort: sortKey },
    scanned: result.scanned, matched: result.matched, returned: hits.length,
    hits: hits.map(h => ({ name: h.name, lng: h.lng, lat: h.lat, score: h.score,
      features: h.features, percentiles: h.pct, groups: h.grp,
      flags: h.flags.map(f => f.text) })) }, null, 2))
} else {
  console.log(`基线：${model.brandLabel}（${model.sampleSize} 个位置）`)
  console.log(`条件：${whereSrc || '（无）'}${near ? `　范围：${near.name} ${radius}m 内` : ''}${minScore ? `　最低分 ${minScore}` : ''}`)
  console.log(`扫描 ${result.scanned} 个真实地址 → ${result.matched} 个符合 → 按 ${spacing}m 去重后取 ${hits.length} 个（按${sortKey}排序）\n`)
  if (!hits.length) console.log('没有符合条件的位置。把条件放宽一点再试，并告诉用户你放宽了哪一条。')
  for (const h of hits) {
    const f = h.features
    console.log(`${String(h.score).padStart(3)} 分  ${h.name}`)
    const g = h.grp || {}
    console.log(`        ${h.lng.toFixed(6)}, ${h.lat.toFixed(6)}  ${f.districtType}  客流基础 ${g.demand ?? '—'} / 可达性 ${g.access ?? '—'} / 位置质量 ${g.pitch ?? '—'}`)
    console.log(`        地铁 ${f.metroDist ?? '—'}m  公交 ${f.busStop300 ?? '—'}  过街 ${f.crossing150 ?? '—'}  停车 ${f.parking300 ?? '—'}  建筑面积 ${f.floorArea500 ? (f.floorArea500 / 1e4).toFixed(0) + '万㎡' : '无数据'}  餐饮 ${f.food500}  同类 ${f.rivals500}`)
    console.log(`        临街 ${f.roadName || '—'}${f.roadClassLabel ? `（${f.roadClassLabel}）` : ''} 退线 ${f.roadDist ?? '—'}m  120m 内道路 ${f.streetLinks ?? '—'} 条  最近商场 ${f.mallDist ?? '—'}m${f.mallName ? `（${f.mallName}）` : ''}`)
    if (f.customerMix) console.log(`        客群：${f.customerMix.top.filter(t => t.share > 0).map(t => `${t.label} ${t.share}%`).join(' / ')}　日夜比 ${f.customerMix.dayNight ?? '—'}`)
    for (const x of h.flags) console.log(`        ⚠ ${x.text}`)
  }
}

if (write && hits.length) {
  const now = new Date().toISOString()
  // Dedupe by distance, not by exact coordinates: two POIs a few metres apart
  // are the same pitch, and matching on equal lng/lat let 麦当劳 and 7-Eleven on
  // the same corner both land in the list as separate candidates.
  const existing = [...(state.sites || [])].filter(s => Number.isFinite(s.lng))
  const added = []
  for (const h of hits) {
    if (existing.some(s => haversine(s, h) < 100)) continue
    existing.push(h)
    // Name a candidate by WHERE it is, not by what is standing there. Taking the
    // POI name gave a Popeyes project candidates called 肯德基 and 麦当劳, two of
    // them duplicated, with nothing to tell them apart.
    const road = h.features?.roadName
    const near = h.name ? `近${h.name}` : ''
    const label = [road, near].filter(Boolean).join(' · ')
      || `${h.features?.districtType || '候选'} ${h.score} 分`
    added.push({ id: `site-${randomUUID().slice(0, 8)}`, kind: 'location', name: label,
      address: '', lng: h.lng, lat: h.lat, area: null, frontage: null, floor: 1,
      rent: null, transferFee: null, landlord: '', hasFlue: null, canLicense: null, hasGas: null,
      source: whereSrc ? `DSH 查询：${whereSrc}`.slice(0, 60) : 'DSH 查询',
      status: 'tovisit', fieldNotes: [], decision: null, createdAt: now, updatedAt: now })
  }
  state.sites = [...(state.sites || []), ...added]
  state.activity = [{ id: randomUUID(), at: now,
    text: `DSH 按条件查询写入 ${added.length} 个候选点位${whereSrc ? `（${whereSrc}）` : ''}` },
    ...(state.activity || [])].slice(0, 200)
  const tmp = `${statePath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, statePath)
  console.log(`\n已写入 project.json：新增 ${added.length} 个点位，工作台几秒内自动刷新。`)
}
