import { mkdir, readFile, readdir, rename, stat, writeFile, appendFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { extractFeatures, TIER_LABEL, walkRadius,
  fitReferenceModel, fitDistrictModel, rankAgainstReference, indexFloorGrid, indexPois,
  indexBasemap, indexMarket, rivalKindsOf, RETAIL_KINDS, FORMATS, formatOf,
  refineKinds } from './model.js'
import { DATASETS } from './datasets.js'
import { siteFromListing } from './market.js'

export const name = 'dsh-site-selection'
export const inject = ['webServer']

const ROOT = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(ROOT, '..', 'public')
const DATA_ROOT = process.env.DSH_SITE_SELECTION_ROOT
  ? resolve(process.env.DSH_SITE_SELECTION_ROOT)
  : join(homedir(), 'Documents', 'DSH 选址项目')
const SCHEMA_VERSION = 1
const MAX_BODY = 24 * 1024 * 1024

// The workbench runs the scoring model itself so that clicking the map answers
// instantly instead of waiting on a round trip; src/model.js is therefore served
// to the browser as a module and is the single implementation both halves use.
const ASSETS = {
  '/api/site-selection/app': [join(PUBLIC, 'index.html'), 'text/html; charset=utf-8'],
  '/api/site-selection/app.css': [join(PUBLIC, 'app.css'), 'text/css; charset=utf-8'],
  '/api/site-selection/app.js': [join(PUBLIC, 'app.js'), 'text/javascript; charset=utf-8'],
  '/api/site-selection/map3d.js': [join(PUBLIC, 'map3d.js'), 'text/javascript; charset=utf-8'],
  '/api/site-selection/model.js': [join(ROOT, 'model.js'), 'text/javascript; charset=utf-8'],
}

// 待看 → 看过 → 上会中 → 已签约 / 已否决. There used to be a 待初筛 stage in
// front of 待看, but nothing ever happened in it: a site was added and the
// next click already meant "go and see it". A stage nobody acts in is noise.
const STATUSES = ['tovisit', 'visited', 'review', 'signed', 'rejected']
// Final states are reached only through `decide`; `site-status` moves between
// the open ones, or backs out of a decision.
const OPEN_STATUSES = ['tovisit', 'visited', 'review']
export const STATUS_LABEL = {
  tovisit: '待看', visited: '看过',
  review: '上会中', signed: '已签约', rejected: '已否决',
}
const REJECT_REASONS = ['租金过高', '客流不足', '商圈不匹配', '竞品密集', '硬件不达标', '房东条件', '政策限制', '其他']

/**
 * Shipped city datasets. They are far too large to copy into every project file
 * or to resend on every 3 s poll, so a project references one by name, the
 * server keeps one parsed copy in memory, and the browser fetches it once from
 * /dataset with a long cache header.
 */
export { DATASETS } from './datasets.js'

const datasetCache = new Map()
async function loadDataset(name) {
  const spec = DATASETS[name]
  if (!spec) return null
  if (datasetCache.has(name)) return datasetCache.get(name)
  const read = async file => (file ? JSON.parse(await readFile(join(ROOT, 'data', file), 'utf8')) : null)
  const [poiDoc, floorDoc, buildingDoc, baseDoc, marketDoc] = await Promise.all([
    read(spec.poi), read(spec.floorArea), read(spec.buildings), read(spec.basemap),
    read(spec.market).catch(() => null)])
  // OSM's tags are wrong about one whole category in China; fix it before
  // anything indexes or counts them. See refineKinds.
  const refined = refineKinds(poiDoc?.pois || [])
  const bundle = {
    name, label: spec.label, brands: spec.brands || [],
    refinedKinds: refined,
    pois: poiDoc?.pois || [],
    places: poiDoc?.places || [],
    index: indexPois(poiDoc?.pois || []),
    // Which POI layers this dataset actually contains, so a never-fetched layer
    // reads as "no data" rather than as a measured zero.
    kinds: new Set((poiDoc?.pois || []).map(p => p.kind)),
    bbox: poiDoc?.bbox || null,
    attribution: { source: poiDoc?.source, license: poiDoc?.license, fetchedAt: poiDoc?.fetchedAt, note: poiDoc?.note },
    floorDoc: floorDoc || null,
    floorGrid: floorDoc ? indexFloorGrid(floorDoc) : null,
    buildings: buildingDoc?.buildings || [],
    buildingNote: buildingDoc?.note || '',
    basemap: baseDoc ? { areas: baseDoc.areas, roads: baseDoc.roads } : null,
    // Street geometry drives the 位置质量 criteria, and the district baseline
    // evaluates thousands of points against it, so the index is built once here.
    basemapIndex: baseDoc ? indexBasemap({ areas: baseDoc.areas, roads: baseDoc.roads }) : null,
    basemapNote: baseDoc?.note || '',
    // The simulated commercial layer. Kept in its own field, behind its own
    // endpoint, and deliberately absent from every scoring context object: the
    // score must stay a function of real observations only.
    market: marketDoc || null,
    marketIndex: marketDoc ? {
      listings: indexMarket(marketDoc.listings),
      footfall: indexMarket(marketDoc.footfall),
      malls: indexMarket(marketDoc.malls),
    } : null,
  }
  datasetCache.set(name, bundle)
  return bundle
}

/**
 * Locations of the reference brand, plus same-category others to compare against.
 *
 * Searched inside the project's own format: asking for 屈臣氏 should look at
 * chemists, not at cafés. When the brand is not found in its own category — a
 * typo, or a chain OSM has not tagged — the search widens to every retail POI
 * rather than silently returning nothing, and the caller is told it widened.
 */
export function brandSplit(pois, brand, format) {
  const needle = String(brand || '').trim().toLowerCase()
  const kinds = rivalKindsOf(format)
  const inFormat = pois.filter(p => kinds.includes(p.kind))
  if (!needle) return { brandPoints: [], background: inFormat, widened: false }
  const hit = p => `${p.brand || ''}${p.name || ''}`.toLowerCase().includes(needle)
  const found = inFormat.filter(hit)
  if (found.length) {
    return { brandPoints: found, background: inFormat.filter(p => !hit(p)), widened: false }
  }
  const all = pois.filter(p => RETAIL_KINDS.includes(p.kind))
  const wide = all.filter(hit)
  return { brandPoints: wide, background: all.filter(p => !hit(p)), widened: wide.length > 0 }
}

const SCRIPT = join(ROOT, '..', 'scripts', 'query-sites.mjs')
const MARKET_SCRIPT = join(ROOT, '..', 'scripts', 'query-listings.mjs')

const now = () => new Date().toISOString()
const num = (value, fallback = null) => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback)
const text = (value, max = 200) => String(value ?? '').trim().slice(0, max)

export function slugify(value, fallback = '') {
  const cleaned = Array.from(String(value ?? '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, ''))
    .slice(0, 64).join('').replace(/-+$/g, '')
  return cleaned || fallback
}

const campaignFolderFor = slug => {
  const safe = slugify(slug)
  if (!safe) throw new Error('项目标识不合法')
  return join(DATA_ROOT, safe)
}

// ── shape ────────────────────────────────────────────────
function emptyProject(id, name, folder) {
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id, name, folder,
      city: '', format: '餐饮', brand: '',
      dataset: '', referenceBrand: '',
      targetCount: null,
      rivals: { brands: [], cuisines: [] },
      requirements: { areaMin: null, areaMax: null, rentMax: null },
      dataNote: '',
      // Which DSH conversation this project is bound to. Kept here, not in the
      // browser: the renderer is served from 127.0.0.1 on a port that changes
      // every launch, so localStorage is a different origin each restart and
      // everything in it silently disappears.
      sessionId: '',
      createdAt: now(), updatedAt: now(),
    },
    sites: [], pois: [],
    selectedId: null, compareIds: [],
    activity: [{ id: randomUUID(), at: now(), text: `创建项目「${name}」` }],
  }
}

/** Every field a site is allowed to carry; anything else is dropped on save. */
const SITE_KEYS = new Set(['id', 'kind', 'parentId', 'name', 'address', 'lng', 'lat', 'area',
  'frontage', 'floor', 'rent', 'transferFee', 'landlord', 'hasFlue', 'canLicense', 'hasGas',
  'hasWater', 'powerKw', 'ceilingM', 'source', 'status', 'fieldNotes', 'decision',
  'createdAt', 'updatedAt'])

/**
 * Two levels, because the business has two.
 *
 * A `location` is a position worth considering — DSH finds those. A `unit` is a
 * specific shop that is actually available at an address, and it belongs to the
 * location it sits in. Both used to land in one flat list distinguished only by
 * a `source` string, so nothing on screen told you which was which.
 */
const SITE_KINDS = ['location', 'unit']

/**
 * @param ignored optional Set collecting what was discarded, so the workbench
 *   can tell DSH what it silently threw away instead of letting DSH believe an
 *   edit landed. See contextDocument.
 */
function normalizeSite(raw, index = 0, ignored = null) {
  const site = raw && typeof raw === 'object' ? raw : {}
  if (ignored) {
    for (const key of Object.keys(site)) {
      if (!SITE_KEYS.has(key)) ignored.add(`sites[].${key}`)
    }
    if (site.status && site.status !== 'screening' && !STATUSES.includes(site.status)) {
      ignored.add(`sites[].status = "${String(site.status).slice(0, 20)}"（不是合法状态，已重置为 tovisit）`)
    }
  }
  return {
    id: text(site.id) || `site-${randomUUID().slice(0, 8)}`,
    kind: SITE_KINDS.includes(site.kind) ? site.kind : 'location',
    parentId: text(site.parentId, 40),
    name: text(site.name, 60) || `候选点位 ${index + 1}`,
    address: text(site.address, 200),
    lng: num(site.lng), lat: num(site.lat),
    area: num(site.area), frontage: num(site.frontage), floor: num(site.floor, 1),
    rent: num(site.rent), transferFee: num(site.transferFee),
    landlord: text(site.landlord, 120),
    hasFlue: typeof site.hasFlue === 'boolean' ? site.hasFlue : null,
    canLicense: typeof site.canLicense === 'boolean' ? site.canLicense : null,
    hasGas: typeof site.hasGas === 'boolean' ? site.hasGas : null,
    // FIELD_CHECKS asks for these three, so they have to survive a save. Left
    // out of this list they were stripped on every write, and the workbench
    // would keep asking for a value the user had already supplied.
    hasWater: typeof site.hasWater === 'boolean' ? site.hasWater : null,
    powerKw: num(site.powerKw),
    ceilingM: num(site.ceilingM),
    source: text(site.source, 60),
    // `screening` is the retired first stage; files written before it went
    // away still carry it, and those sites were waiting to be seen.
    status: STATUSES.includes(site.status) ? site.status : 'tovisit',
    fieldNotes: (Array.isArray(site.fieldNotes) ? site.fieldNotes : []).map(note => ({
      id: text(note?.id) || randomUUID(),
      at: note?.at || now(),
      author: text(note?.author, 40) || '你',
      peakFlow: num(note?.peakFlow), offpeakFlow: num(note?.offpeakFlow),
      observation: text(note?.observation, 1000),
      vibe: text(note?.vibe, 60),
    })),
    decision: site.decision && typeof site.decision === 'object' ? {
      result: text(site.decision.result, 20),
      reasons: (Array.isArray(site.decision.reasons) ? site.decision.reasons : []).map(r => text(r, 40)),
      note: text(site.decision.note, 600),
      at: site.decision.at || now(),
    } : null,
    createdAt: site.createdAt || now(),
    updatedAt: site.updatedAt || now(),
  }
}

const metresBetween = (a, b) => {
  const R = 6371000, rad = d => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Give every unit a parent.
 *
 * Units adopted before the two-level model existed have no `parentId`, and a
 * unit floating at the top of the list is exactly the confusion this change is
 * meant to remove. Each one is attached to the nearest location; a project with
 * no locations at all leaves them where they are rather than inventing one.
 */
function linkUnits(sites) {
  const locations = sites.filter(s => s.kind === 'location' && Number.isFinite(s.lng))
  const byId = new Map(sites.map(s => [s.id, s]))
  for (const site of sites) {
    if (site.kind !== 'unit') continue
    const parent = site.parentId ? byId.get(site.parentId) : null
    if (parent && parent.kind === 'location') continue
    site.parentId = ''
    if (!Number.isFinite(site.lng) || !locations.length) continue
    let best = null
    for (const loc of locations) {
      const d = metresBetween(site, loc)
      if (!best || d < best.d) best = { d, loc }
    }
    if (best) site.parentId = best.loc.id
  }
}

export function migrate(state, folder, slug) {
  const out = state && typeof state === 'object' ? state : {}
  out.schemaVersion = SCHEMA_VERSION
  const project = out.project && typeof out.project === 'object' ? out.project : {}
  project.id = slug
  project.name = text(project.name, 80) || slug
  project.folder = folder
  project.city = text(project.city, 40)
  project.format = text(project.format, 40) || '餐饮'
  project.brand = text(project.brand, 40)
  project.sessionId = text(project.sessionId, 120)
  project.dataset = DATASETS[project.dataset] ? project.dataset : ''
  if (!project.dataset) {
    const anchors = [...(Array.isArray(out.sites) ? out.sites : []), ...(Array.isArray(out.stores) ? out.stores : []),
      ...(Array.isArray(out.pois) ? out.pois.slice(0, 200) : [])].filter(p => Number.isFinite(p?.lng))
    if (anchors.length) {
      const lng = anchors.reduce((a, p) => a + p.lng, 0) / anchors.length
      const lat = anchors.reduce((a, p) => a + p.lat, 0) / anchors.length
      const found = Object.entries(DATASETS).find(([, spec]) => spec.bbox
        && lng >= spec.bbox.minLng && lng <= spec.bbox.maxLng
        && lat >= spec.bbox.minLat && lat <= spec.bbox.maxLat)
      if (found) {
        project.dataset = found[0]
        if (!project.city) project.city = found[1].label.split(' · ')[0]
        // Its inline copy of the dataset is now redundant; drop it so the file
        // stops carrying thousands of duplicated rows.
        if (Array.isArray(out.pois) && out.pois.length > 500) out.pois = []
      }
    }
  }
  project.referenceBrand = text(project.referenceBrand, 40)
  project.targetCount = num(project.targetCount)
  project.rivals = {
    brands: (Array.isArray(project.rivals?.brands) ? project.rivals.brands : []).map(b => text(b, 40)).filter(Boolean),
    cuisines: (Array.isArray(project.rivals?.cuisines) ? project.rivals.cuisines : []).map(c => text(c, 40)).filter(Boolean),
  }
  project.requirements = {
    areaMin: num(project.requirements?.areaMin), areaMax: num(project.requirements?.areaMax),
    rentMax: num(project.requirements?.rentMax),
  }
  project.dataNote = text(project.dataNote, 500)
  project.createdAt = project.createdAt || now()
  project.updatedAt = project.updatedAt || now()
  out.project = project

  out.pois = (Array.isArray(out.pois) ? out.pois : []).filter(p => p && Number.isFinite(p.lng) && Number.isFinite(p.lat))
  out.referenceModel = null
  out.districtModel = null
  delete out.stores          // the own-revenue mode this served has been removed
  delete out.brandModel
  const ignored = new Set()
  out.sites = (Array.isArray(out.sites) ? out.sites : []).map((raw, i) => normalizeSite(raw, i, ignored))
  linkUnits(out.sites)
  // Not persisted — it describes the last read, not the project.
  Object.defineProperty(out, 'ignoredFields', { value: [...ignored], enumerable: false, configurable: true })
  const ids = new Set(out.sites.map(s => s.id))
  out.selectedId = ids.has(out.selectedId) ? out.selectedId : (out.sites[0]?.id ?? null)
  out.compareIds = (Array.isArray(out.compareIds) ? out.compareIds : []).filter(id => ids.has(id)).slice(0, 4)
  out.activity = (Array.isArray(out.activity) ? out.activity : [])
    .filter(e => e && e.text)
    .map(e => ({ id: text(e.id) || randomUUID(), at: e.at || now(), text: text(e.text, 300) }))
    .slice(0, 200)
  return out
}

// Fitting the reference model walks every brand store against every POI (~0.9 s
// for Beijing), which cannot run on a 3 s poll. It only depends on the dataset
// and the brand, so it is cached on that pair.
const referenceCache = new Map()
async function referenceModelFor(project) {
  if (!project.dataset || !project.referenceBrand) return null
  const key = `${project.dataset}::${project.referenceBrand}`
  if (referenceCache.has(key)) return referenceCache.get(key)
  const bundle = await loadDataset(project.dataset)
  if (!bundle) return null
  const { brandPoints, background } = brandSplit(bundle.pois, project.referenceBrand, project.format)
  const model = fitReferenceModel(brandPoints, background, bundle.pois, {
    brandLabel: project.referenceBrand, floorGrid: bundle.floorGrid,
    basemapIndex: bundle.basemapIndex, availableKinds: bundle.kinds, format: project.format,
    brandPoints, index: bundle.index,
  })
  referenceCache.set(key, model)
  return model
}

// The default when no brand is nominated: rank against every location in the
// district that already hosts a shop. Costs ~0.6 s to fit, so it is cached per
// dataset and every probe after that is sub-millisecond.
const districtCache = new Map()
async function districtModelFor(datasetName, format) {
  if (!datasetName) return null
  // The baseline's competition metric depends on the format, so two projects on
  // the same city with different formats need different models. Keying the
  // cache on the dataset alone would serve a pharmacy project the café baseline.
  const key = `${datasetName}::${format || ''}`
  if (districtCache.has(key)) return districtCache.get(key)
  const bundle = await loadDataset(datasetName)
  if (!bundle) return null
  const model = fitDistrictModel(bundle.pois, {
    index: bundle.index, floorGrid: bundle.floorGrid, basemapIndex: bundle.basemapIndex,
    availableKinds: bundle.kinds, format,
    syntheticStores: bundle.market?.syntheticStores || [],
    districtLabel: bundle.label.split(' · ').pop() || bundle.label,
  })
  districtCache.set(key, model)
  return model
}

/**
 * Derived state — never trusted from the file, always recomputed.
 * Two scoring paths: an operator with their own revenue gets the yield model;
 * someone opening their first shop gets ranked against a reference brand's
 * existing locations instead.
 */
async function withDerived(state) {
  const bundle = state.project.dataset ? await loadDataset(state.project.dataset) : null
  const pois = bundle ? [...bundle.pois, ...state.pois] : state.pois
  const floorGrid = bundle?.floorGrid || null
  const basemapIndex = bundle?.basemapIndex || null
  const availableKinds = bundle?.kinds || null
  const { brandPoints } = bundle ? brandSplit(bundle.pois, state.project.referenceBrand, state.project.format) : { brandPoints: [] }

  const index = bundle?.index || null
  state.referenceModel = await referenceModelFor(state.project)
  state.districtModel = await districtModelFor(state.project.dataset, state.project.format)

  // A nominated brand beats the district baseline; the baseline is the default
  // precisely so that nothing has to be nominated.
  const mode = state.referenceModel?.ready ? 'reference'
    : state.districtModel?.ready ? 'district' : 'none'
  const rankModel = mode === 'reference' ? state.referenceModel : state.districtModel
  const ctx = { rivals: state.project.rivals, floorGrid, brandPoints, index, basemapIndex,
    availableKinds, format: state.project.format }
  const scores = {}
  for (const site of state.sites) {
    scores[site.id] = { ...rankAgainstReference(site, pois, rankModel, ctx), mode }
  }
  return { state, scores, bundle, pois, floorGrid, basemapIndex, availableKinds, brandPoints, index, mode, rankModel }
}

// ── context for the bound DSH session ────────────────────
function contextDocument(state, scores) {
  const p = state.project
  const selected = state.sites.find(s => s.id === state.selectedId)
  const bm = state.districtModel || state.referenceModel
  const lines = [
    '# 选址工作台上下文', '',
    '你正在与 DSH Desktop 的「门店选址工作台」协作。本会话的工作目录就是当前项目文件夹。', '',
    '## 分工', '',
    '- 你负责机械劳动：解析铺源信息、补全点位字段、交叉比对、生成上会材料初稿。',
    '- 人负责判断：踩点实感、商业条件、签不签。**不要替用户下结论，不要写 decision 字段。**',
    '- `project.json` 是工作台与你共用的唯一事实源，你直接编辑它，界面几秒内自动刷新。', '',

    '## 怎么跟用户说话', '',
    '**这份文档是写给你的，不是写给用户的。不要把里面的规则复述给他。**',
    '用户不关心 `project.json` 的字段名、`--write` 参数、`status:"tovisit"` 这些东西——',
    '那是你的工具，不是他的工作。他要的是「找到了几个点、都在哪、哪个值得去看」。', '',
    '对照着说：', '',
    '| 不要说 | 说 |',
    '|---|---|',
    '| 我加 `--write` 落盘到 project.json | 我把这 8 个存进点位清单了 |',
    '| 数值字段量不到就留 null | 面积和租金我没查到，等你问到再填 |',
    '| 硬性布尔 hasFlue 填 false 判「不建议」| 这家没排烟，做餐饮直接排除 |',
    '| 候选点位 sites 数组追加 | 名单里新增了 3 个 |',
    '| 我只能编辑 project.json | （不用说，这是你的实现细节）|', '',
    '需要用户确认时，说清楚你要做什么、影响什么，然后等他回答。不要报菜名式地列一遍规则。', '',
    '**排版从简。** 结论用普通段落和短句，一次别超过十行。',
    '不要用大号数字卡片、不要为几个指标铺一整张表——右侧对话框很窄，那些排版会把',
    '「81,060」这样一个数字撑成三行。要列多个点位时用最简单的表格，一行一个，别加装饰。', '',
    '## 两级：位置与铺源', '',
    '`sites` 里有两种东西，用 `kind` 区分：', '',
    '- `kind:"location"`（默认）——**一个值得考虑的位置**。你用 query-sites.mjs 找出来的都是这种。',
    '- `kind:"unit"`——**一间具体在租的铺**，必须带 `parentId` 指向它所在的位置。',
    '  用 query-listings.mjs --adopt 收进来的都是这种，会自动挂到最近的位置下。', '',
    '业务上就是两步：先判断这个位置行不行，再看这里有什么铺可租。', '',
    '**用户让你找位置时，默认把两步一起做完**：先 query-sites.mjs 选位置，',
    '再对选中的位置跑 query-listings.mjs --near-sites，把结果一起念给他——',
    '「找到 8 个位置，其中 5 个附近有在租的铺」。他不必分两次问。',
    '（工作台的点位详情里也会自动列出 400m 内的在租铺源，所以不必逐个 --adopt，',
    '只有用户明确要跟进某间铺时才收进清单。）', '',

    '## 编辑 project.json 的规则', '',
    '- 保留 `schemaVersion` 和已有点位的 `id`、`fieldNotes`、`decision`。',
    '- 新增候选位置往 `sites` 追加，`kind:"location"`，必须给出：`id`(site-xxxxxxxx)、`name`、`address`、`lng`、`lat`、',
    '  `area`(㎡)、`rent`(元/月)、`status:"tovisit"`、`createdAt`、`updatedAt`。',
    '  能确定就填 `frontage`(临街面宽 m)、`floor`、`transferFee`、`landlord`、`source`。',
    '- 硬性布尔字段，不确定就填 `null`，不要猜：',
    '  `hasFlue`(排烟条件)、`canLicense`(可办食品经营许可)、`hasWater`(独立上下水)、`hasGas`(燃气)。',
    '  前三个只要填了 `false`，这个点位直接判「不建议」，分数再高也一样。',
    '- 数值型的现场字段，量到/问到才填，否则留 `null`：',
    '  `frontage`(临街面宽 m)、`ceilingM`(净层高 m)、`powerKw`(报装容量 kW)、`floor`(楼层)、',
    '  `area`(㎡)、`rent`(元/月)。这些数据里一定没有——工作台每个点位下面都列着还缺哪几项，',
    '  你每补一项那个清单就短一条。**补不到就说补不到，不要填一个看起来合理的数。**',
    '- **不要写评分或基线**——它们由工作台从城市数据集实时算出，写了会被覆盖。',
    '- 上面这些字段规则是给你看的实现细节，不要念给用户听。',
    `- 本项目业态是 **${formatOf(p.format)?.label || p.format || '未设'}**。「同类竞争」按这个业态算——`,
    '  开药店就数药店，不会把咖啡店当竞品。要改业态用 `project.format`（见下方可选值）。',
    '- 用户说某个点位「去看过了，pass」时：把 `status` 改成 `rejected`，把他的原话记进 `fieldNotes`',
    '  的 `observation`（字段名就是 `observation`，不是 `text`），**`decision` 留给他自己写**。',
    '- 在 `activity` 数组开头插入一条 `{id, at, text}` 说明你做了什么。', '',
    '## 用户说要什么样的点位时，用这个工具查', '',
    '这是你最重要的一个能力。用户会用自己的话提要求——「地铁 200 米以内」「周边餐饮多」「在商场里」',
    '「大学附近」「竞争别太密」——你的工作是把它翻译成一条 `--where` 表达式去查，**不要靠网页搜索猜坐标**。', '',
    '```bash',
    `node ${SCRIPT} --fields                    # 先看有哪些字段可以查`,
    `node ${SCRIPT} --where "f.metroDist < 200 && f.food500 > 30" --limit 20`,
    `node ${SCRIPT} --where "f.districtType === '商场' && f.cafe500 < 5" --near 三里屯 --radius 2500`,
    `node ${SCRIPT} --where "s >= 80" --limit 20 --write`,
    '```', '',
    '- `--where` 是任意 JS 布尔表达式，可用 `f`（特征）、`p`（各项百分位）、`s`（综合分）、',
    '  `g`（三个维度分：`g.demand` 客流基础 / `g.access` 可达性 / `g.pitch` 位置质量）、`n`（地点本身）',
    '- `--near <地名或 lng,lat> --radius <米>` 限定范围，地名会在数据里模糊匹配',
    '- `--sort score|metro|food|floor|cafe`，`--limit`，`--spacing <米>`（去重间距，默认 250）',
    '- `--json` 输出结构化结果；`--write` **直接写进 project.json**，工作台几秒内自动刷新',
    '',
    '**先跑 `--fields`**：它会列出所有可查字段，以及数据里**没有**的东西（实测人流量、商场档次、租金、',
    '客群消费力）。前四样可以用下面的铺源工具查。',
    '除此之外用户提到数据里没有的东西时，要么用代理指标并说明是代理，要么直说数据里没有——',
    '不要用一段看起来专业的分析把这件事糊过去。', '',
    '典型节奏：`--fields` 看字段 → 组表达式跑一遍 → 把结果念给用户 → 用户认可后加 `--write` 落盘。',
    '一条都查不到就把条件放宽再试，并明确告诉用户你放宽了哪一条。', '',

    '## 铺源 / 客流 / 商场档次', '',
    '上面那个工具查的是「哪里适合开店」。这个工具查的是「那里现在有什么铺在租、多少钱、客流多少」。', '',
    '```bash',
    `node ${MARKET_SCRIPT} --fields                        # 字段口径`,
    `node ${MARKET_SCRIPT} --near-sites --radius 300       # 项目里每个点位附近在租的铺`,
    `node ${MARKET_SCRIPT} --near-sites --where "l.hasFlue && l.rentPerMonth < 35000"`,
    `node ${MARKET_SCRIPT} --footfall --near-sites         # 每个点位的日均客流、构成、客单价`,
    `node ${MARKET_SCRIPT} --malls --near-sites --radius 500   # 附近商场档次、空置率、同业数`,
    `node ${MARKET_SCRIPT} --adopt lst-0123                # 把铺源收进点位，字段自动填好`,
    '```', '',
    '`--adopt` 会把铺源的面积/租金/层高/面宽/电量/排烟/上下水一次性填进点位，',
    '界面上那个「还需要你或 DSH 补的」清单会当场变短。租金与硬件条件签约前仍需现场核实。', '',
    '典型循环：`query-sites.mjs` 选 10 个点位 → `query-listings.mjs --near-sites` 看有什么在租 →',
    '念给用户听 → 用户说「A、C 我去看过了，pass」→ 你把那几个点位的 `status` 改成 `rejected`、',
    '在 `decision` 留空但在 `fieldNotes` 里记下用户的原话 → 再跑一次查询（被否决的点位会自动排除）。', '',
    '## 坐标', '',
    '- `lng`/`lat` 用 WGS-84。如果只有文字地址而无法确定坐标，把 `lng`/`lat` 留成 `null`，',
    '  并在 `activity` 里说明哪几个点位需要用户补坐标——不要编造坐标。', '',
    '## 当前项目', '',
    `- 名称：${p.name}`,
    `- 城市：${p.city || '（未填写）'}　业态：${p.format}　品牌：${p.brand || '（未填写）'}`,
    `- 候选点位：${state.sites.length} 个`,
  ]
  if (p.requirements.areaMin || p.requirements.areaMax || p.requirements.rentMax) {
    lines.push(`- 硬性要求：面积 ${p.requirements.areaMin ?? '—'}–${p.requirements.areaMax ?? '—'} ㎡，月租上限 ${p.requirements.rentMax ?? '—'} 元`)
  }
  if (p.dataNote) lines.push('', `> 数据说明：${p.dataNote}`)

  // Tell DSH what the last save threw away. Without this it edits project.json,
  // sees no error, and reports success for a change that never landed.
  if (state.ignoredFields?.length) {
    lines.push('', '## ⚠ 上次读取时被忽略的字段', '',
      '你写进 `project.json` 的下面这些内容**没有被保留**——工作台只认固定的字段集合，',
      '其余的在每次读取时丢弃。**不要再写它们，也不要告诉用户这些改动生效了。**', '')
    for (const f of state.ignoredFields) lines.push(`- \`${f}\``)
    lines.push('',
      '常见原因：`score`/`tier` 是工作台实时算的（写了会被覆盖）；`notes`/`photos`/`tags` 之类',
      '不在字段集合里——踩点观察请写进 `fieldNotes[].observation`。', '')
  }

  lines.push('', `## 可选业态（\`project.format\` 的取值）`, '')
  lines.push(FORMATS.map(f => `\`${f.id}\`(${f.label})`).join('　'))
  lines.push('', '## 评分是怎么算的（你需要能向用户解释）', '')
  lines.push(
    '综合分 = **客流基础 / 可达性 / 位置质量 三个维度先各自算百分位平均，再把三个维度平均**。',
    '不是把所有指标拉平均——可达性下面有 4 个指标、客流基础只有 3 个，直接平均等于让可达性自动更重要。', '',
    '- **客流基础**：500m 建筑面积、500m 餐饮数、最近商场距离',
    '- **可达性**：最近地铁出入口、300m 公交站、150m 过街设施、300m 停车场',
    '- **位置质量**：120m 内道路数（路网交汇度）、500m 街道总长（街区密度）',
    '- **竞争**（500m 内同业态门店）只作提示，不计分：同类多既是竞争也是客流验证，没有单一方向',
    '- **客群结构**（上班族/居民/学生/外来客流占比）只画像，不计分：',
    '  90% 上班族对午市食堂是好事、对周末早午餐是灾难，不存在「越高越好」', '',
    '两个必须如实告诉用户的数据限制：', '',
    '1. 路网只有主次干道和部分支路，很多小巷不在里面。所以 `f.streetLinks` 用的是 120m 半径，',
    '   它说的是「有几条路在附近汇合」，**不等于「这个铺是拐角位」**。用户问拐角位就说要现场看。',
    '2. OSM 的商业用地范围在国内画得很不全，一个 0 往往是「没人标」而不是「不是商业区」，',
    '   所以商业用地占比算得出来也没放进打分。不要拿 `f.landuse` 当结论，它 null 很常见。', '',
    '## 评分基线（工作台算出，只读）', '')
  if (bm?.ready) {
    for (const s of bm.statements) lines.push(`- ${s}`)
  } else {
    lines.push(`- 尚未建立基线：${bm?.reason || '缺少数据集'}`)
  }

  lines.push('', '## 候选点位', '')
  if (!state.sites.length) lines.push('- （还没有候选点位。用户可能会把中介发来的铺源文字交给你解析。）')
  for (const site of state.sites) {
    const sc = scores[site.id]
    const bits = [`\`${site.id}\``, site.name, STATUS_LABEL[site.status]]
    if (sc?.score !== null && sc?.score !== undefined) bits.push(`评分 ${sc.score}`)
    if (sc?.tier) bits.push(TIER_LABEL[sc.tier])
    if (!Number.isFinite(site.lng)) bits.push('⚠ 缺坐标')
    lines.push(`- ${bits.join(' · ')}`)
  }

  lines.push('', '## 当前选中', '')
  if (!selected) {
    lines.push('用户还没有选中点位。')
  } else {
    const sc = scores[selected.id]
    lines.push(`${selected.name}（\`${selected.id}\`）　${selected.address || '（无地址）'}`,
      `状态：${STATUS_LABEL[selected.status]}　面积 ${selected.area ?? '—'} ㎡　月租 ${selected.rent ?? '—'} 元`)
    if (sc?.features) {
      const f = sc.features
      lines.push(`商圈类型：${f.districtType}　最近地铁 ${f.metroDist ?? '—'}m　500m 餐饮 ${f.food500} 家　同业态竞品 ${f.rival500} 家`)
    }
    if (sc?.exclusions?.length) lines.push(`硬性排除：${sc.exclusions.map(e => e.text).join('；')}`)
    if (sc?.conflicts?.length) lines.push(`矛盾信号：${sc.conflicts.map(c => c.text).join('；')}`)
    if (selected.fieldNotes.length) {
      lines.push('踩点记录：')
      for (const note of selected.fieldNotes) {
        lines.push(`  - 高峰 ${note.peakFlow ?? '—'} 人/时，平峰 ${note.offpeakFlow ?? '—'} 人/时。${note.observation}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

async function writeContext(folder, state, scores) {
  const target = join(folder, 'CONTEXT.md')
  const content = contextDocument(state, scores)
  try { if (await readFile(target, 'utf8') === content) return } catch {}
  await writeFile(target, content, 'utf8')
}

// ── persistence ──────────────────────────────────────────
export async function ensureProject(slug, seed = {}) {
  const folder = campaignFolderFor(slug)
  const id = slugify(slug)
  await Promise.all([
    mkdir(join(folder, 'photos'), { recursive: true }),
    mkdir(join(folder, 'exports'), { recursive: true }),
  ])
  const statePath = join(folder, 'project.json')
  let state
  try {
    state = migrate(JSON.parse(await readFile(statePath, 'utf8')), folder, id)
  } catch {
    state = emptyProject(id, text(seed.name, 80) || id, folder)
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  const derived = await withDerived(state)
  await writeContext(folder, state, derived.scores)
  return { folder, statePath, ...derived }
}

async function saveState(folder, state, log) {
  state.project.updatedAt = now()
  if (log?.text) {
    state.activity.unshift({ id: randomUUID(), at: now(), text: log.text })
    state.activity = state.activity.slice(0, 200)
  }
  const statePath = join(folder, 'project.json')
  const temp = `${statePath}.${process.pid}.tmp`
  const { referenceModel, districtModel, ...persist } = state
  await writeFile(temp, `${JSON.stringify({ ...persist, referenceModel: null, districtModel: null }, null, 2)}\n`, 'utf8')
  await rename(temp, statePath)
  if (log?.durable) await appendFile(join(folder, 'decisions.md'), `- ${now()} — ${log.text}\n`, 'utf8')
  const derived = await withDerived(state)
  await writeContext(folder, state, derived.scores)
  return derived
}

function projectSummary(state) {
  const live = state.sites.filter(s => !['rejected', 'signed'].includes(s.status))
  return {
    id: state.project.id, name: state.project.name,
    city: state.project.city, brand: state.project.brand,
    referenceBrand: state.project.referenceBrand,
    dataset: state.project.dataset,
    sessionId: state.project.sessionId || '',
    sites: state.sites.length,
    updatedAt: state.project.updatedAt,
    statusLabel: !state.sites.length ? '还没有点位'
      : `${live.length} 个在跟进 / 共 ${state.sites.length}`,
  }
}

async function listProjects() {
  await mkdir(DATA_ROOT, { recursive: true })
  const entries = await readdir(DATA_ROOT, { withFileTypes: true })
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = slugify(entry.name)
    if (!id) continue
    try {
      const raw = JSON.parse(await readFile(join(DATA_ROOT, entry.name, 'project.json'), 'utf8'))
      rows.push(projectSummary(migrate(raw, join(DATA_ROOT, entry.name), id)))
    } catch {}
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

// ── actions ──────────────────────────────────────────────
const siteOf = (state, id) => state.sites.find(s => s.id === id)
function requireSite(state, id) {
  const site = siteOf(state, id)
  if (!site) throw new Error('点位不存在')
  return site
}

export function applyAction(state, action) {
  const type = action?.type

  if (type === 'select') {
    if (action.id !== null && !siteOf(state, action.id)) throw new Error('点位不存在')
    state.selectedId = action.id
    return null
  }
  if (type === 'compare') {
    // Any size is storable, including one: the "needs two" rule belongs to the
    // comparison view, not to the act of ticking a box. Rejecting a one-item set
    // made the list impossible to build up one click at a time.
    state.compareIds = Array.isArray(action.ids)
      ? [...new Set(action.ids)].filter(id => siteOf(state, id)).slice(0, 4) : []
    return null
  }
  if (type === 'bind-session') {
    const id = text(action.sessionId, 120)
    if (!id) throw new Error('会话 id 不能为空')
    state.project.sessionId = id
    state.project.updatedAt = now()
    // No activity entry: binding a conversation is plumbing, not a decision the
    // user made, and saveState skips the log when the text is empty.
    return { text: '', durable: false }
  }
  if (type === 'adopt-listing') {
    const listing = (action.listing && typeof action.listing === 'object') ? action.listing : null
    if (!listing?.id) throw new Error('缺少铺源')
    const dup = state.sites.find(x => String(x.source || '').includes(listing.id))
    if (dup) return { text: '', durable: false }
    // Attach to the nearest saved location, same rule the CLI uses.
    let parent = null
    for (const loc of state.sites) {
      if (loc.kind === 'unit' || !Number.isFinite(loc.lng)) continue
      const d = metresBetween(loc, listing)
      if (!parent || d < parent.d) parent = { d, loc }
    }
    const site = normalizeSite(siteFromListing(listing, now(), parent?.loc.id || ''))
    state.sites.push(site)
    state.selectedId = site.id
    return {
      text: parent
        ? `收入「${parent.loc.name}」下的铺源：${site.name}`
        : `收入铺源：${site.name}`,
      durable: false,
    }
  }
  if (type === 'rename-project') {
    const name = text(action.name, 80)
    if (!name) throw new Error('项目名称不能为空')
    const before = state.project.name
    if (name === before) return null
    state.project.name = name
    // The folder keeps its original slug on purpose: renaming a directory that a
    // bound DSH session has as its cwd would break the session underneath it.
    return { text: `项目「${before}」改名为「${name}」`, durable: false }
  }

  if (type === 'project-meta') {
    const p = state.project
    for (const key of ['city', 'brand', 'format']) if (typeof action[key] === 'string') p[key] = text(action[key], 40)
    if (action.targetCount !== undefined) p.targetCount = num(action.targetCount)
    if (action.rivalBrands !== undefined) {
      p.rivals.brands = String(action.rivalBrands || '').split(/[,，、\s]+/).map(s => text(s, 40)).filter(Boolean).slice(0, 30)
    }
    for (const key of ['areaMin', 'areaMax', 'rentMax']) {
      if (action[key] !== undefined) p.requirements[key] = num(action[key])
    }
    return { text: '更新项目设置', durable: false }
  }
  if (type === 'create-site') {
    const site = normalizeSite({ ...action.site, id: undefined }, state.sites.length)
    state.sites.push(site)
    state.selectedId = site.id
    return { text: `新增候选点位「${site.name}」`, durable: true }
  }
  if (type === 'import-sites') {
    const rows = Array.isArray(action.sites) ? action.sites : []
    if (!rows.length) throw new Error('没有可导入的点位')
    let added = 0
    for (const row of rows.slice(0, 200)) {
      state.sites.push(normalizeSite({ ...row, id: undefined, source: row.source || '批量导入' }, state.sites.length))
      added += 1
    }
    return { text: `批量导入 ${added} 个候选点位`, durable: true }
  }
  const site = requireSite(state, action.id)

  if (type === 'update-site') {
    const patch = action.patch && typeof action.patch === 'object' ? action.patch : {}
    const merged = normalizeSite({ ...site, ...patch, id: site.id, fieldNotes: site.fieldNotes, decision: site.decision })
    Object.assign(site, merged, { updatedAt: now() })
    return { text: `更新点位「${site.name}」资料`, durable: false }
  }
  if (type === 'site-status') {
    // Signing or rejecting goes through `decide`, which insists on a reason.
    if (!OPEN_STATUSES.includes(action.status)) throw new Error('状态不合法')
    const was = site.status
    site.status = action.status
    site.updatedAt = now()
    // Backing out of a decision: the record would otherwise sit in the file
    // saying 已签约 under a site the list shows as 上会中. The activity log
    // keeps both the decision and this reversal.
    if (site.decision && ['signed', 'rejected'].includes(was)) {
      site.decision = null
      return { text: `「${site.name}」撤回${STATUS_LABEL[was]}，退回${STATUS_LABEL[action.status]}`, durable: true }
    }
    return { text: `「${site.name}」状态改为${STATUS_LABEL[action.status]}`, durable: true }
  }
  if (type === 'field-note') {
    const observation = text(action.observation, 1000)
    if (!observation && !Number.isFinite(num(action.peakFlow))) throw new Error('请至少填写实测人流或现场观察')
    site.fieldNotes.push({
      id: randomUUID(), at: now(), author: '你',
      peakFlow: num(action.peakFlow), offpeakFlow: num(action.offpeakFlow),
      observation, vibe: text(action.vibe, 60),
    })
    if (site.status === 'tovisit') site.status = 'visited'
    site.updatedAt = now()
    return { text: `「${site.name}」新增踩点记录`, durable: true }
  }
  if (type === 'delete-note') {
    const before = site.fieldNotes.length
    site.fieldNotes = site.fieldNotes.filter(n => n.id !== action.noteId)
    if (site.fieldNotes.length === before) throw new Error('记录不存在')
    site.updatedAt = now()
    return { text: `「${site.name}」删除踩点记录`, durable: false }
  }
  if (type === 'decide') {
    const result = text(action.result, 20)
    if (!['signed', 'rejected'].includes(result)) throw new Error('结论只能是签约或否决')
    const reasons = (Array.isArray(action.reasons) ? action.reasons : []).map(r => text(r, 40)).filter(r => REJECT_REASONS.includes(r))
    if (result === 'rejected' && !reasons.length && !text(action.note)) throw new Error('否决必须填写理由')
    site.decision = { result, reasons, note: text(action.note, 600), at: now() }
    site.status = result
    site.updatedAt = now()
    const label = result === 'signed' ? '签约' : `否决（${reasons.join('、') || '见说明'}）`
    return { text: `「${site.name}」${label}`, durable: true }
  }
  if (type === 'delete-site') {
    state.sites = state.sites.filter(s => s.id !== site.id)
    state.compareIds = state.compareIds.filter(id => id !== site.id)
    if (state.selectedId === site.id) state.selectedId = state.sites[0]?.id ?? null
    return { text: `删除点位「${site.name}」`, durable: true }
  }
  throw new Error('不支持的操作')
}

// ── http ─────────────────────────────────────────────────
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function serveAsset(pathname, res) {
  const [file, contentType] = ASSETS[pathname]
  const bytes = await readFile(file)
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
  res.end(bytes)
}

const projectParam = url => {
  const slug = slugify(url.searchParams.get('project') || '')
  if (!slug) throw new Error('缺少 project 参数')
  return slug
}

export const SAMPLES = {
  'shanghai-coffee': { file: 'sample-shanghai-coffee.json', label: '主理人咖啡厅 · 静安',
    blurb: '在上海静安开第一家主理人咖啡厅，5 个候选点位' },
  'beijing-tea': { file: 'sample-beijing-tea.json', label: '去茶山 · 北京朝阳',
    blurb: '茶饮品牌进京，朝阳区前 3 家，5 个候选点位' },
}

async function loadSample(folder, state, which = 'shanghai-coffee') {
  const spec = SAMPLES[which] || SAMPLES['shanghai-coffee']
  const sample = JSON.parse(await readFile(join(ROOT, 'data', spec.file), 'utf8'))
  const bundle = await loadDataset(sample.dataset)
  // Name the dataset instead of copying it in: the map layer loads from the
  // shared bundle, so without this the sample project rendered no map at all.
  state.pois = []
  state.sites = sample.sites.map(normalizeSite)
  state.selectedId = state.sites[0]?.id ?? null
  state.compareIds = state.sites.slice(0, 2).map(s => s.id)
  Object.assign(state.project, sample.project)
  state.project.dataset = sample.dataset
  state.project.dataNote = sample.dataNote
  return { text: `载入示例项目「${spec.label}」（${bundle.pois.length} 条真实 POI + 底图 + ${state.sites.length} 个候选点位）`, durable: false }
}

export async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')

  if (ASSETS[url.pathname]) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    return serveAsset(url.pathname, res)
  }

  /**
   * Long-poll for changes to project.json.
   *
   * The panel used to poll on a 3-second timer, but its iframe reports
   * `visibilityState: 'hidden'` to Chrome, which throttles timers there — a 1 s
   * interval measured 6 fires in 13 s, and background throttling can stretch it
   * to once a minute. So when DSH edited the file the list just sat there, and
   * "delete this site" looked like it had done nothing.
   *
   * A request already in flight is not a timer, so it is not throttled. This
   * holds the connection until the file actually changes, which also drops the
   * update latency from seconds to milliseconds.
   */
  if (url.pathname === '/api/site-selection/watch') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const slug = slugify(url.searchParams.get('project') || '')
    if (!slug) return json(res, 400, { error: '缺少 project 参数' })
    const folder = campaignFolderFor(slug)
    const statePath = join(folder, 'project.json')
    const since = String(url.searchParams.get('since') || '')
    const revOf = async () => {
      try { const info = await stat(statePath); return `${info.mtimeMs}:${info.size}` } catch { return '' }
    }
    const current = await revOf()
    if (current !== since) return json(res, 200, { revision: current, changed: true })

    await new Promise(resolve => {
      let settled = false
      let watcher = null
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { watcher?.close() } catch {}
        resolve()
      }
      // Watch the folder, not the file: saveState writes a temp file and renames
      // over the target, which replaces the inode and silently kills a
      // file-level watch after the first write.
      try {
        watcher = watch(folder, (_event, name) => { if (!name || name === 'project.json') finish() })
      } catch { /* platform without fs.watch — fall through to the timeout */ }
      // Return periodically even with no change, so proxies and sleeping
      // laptops cannot leave the client holding a dead socket forever.
      const timer = setTimeout(finish, 25000)
      req.on('close', finish)
    })
    if (res.writableEnded) return undefined
    const after = await revOf()
    return json(res, 200, { revision: after, changed: after !== since })
  }

  if (url.pathname === '/api/site-selection/bootstrap') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const { folder, state, scores, statePath, mode } = await ensureProject(projectParam(url))
    const info = await stat(statePath)
    return json(res, 200, { folder, state, scores, mode, revision: `${info.mtimeMs}:${info.size}` })
  }

  if (url.pathname === '/api/site-selection/projects') {
    // `root` lets the client identify the DSH workspaces this plugin created:
    // deleting a project must also retire its workspace, or the sidebar keeps
    // showing folders for projects that no longer exist.
    if (req.method === 'GET') return json(res, 200, { projects: await listProjects(), root: DATA_ROOT })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const payload = await readBody(req)
    const name = text(payload.name, 80)
    if (!name) return json(res, 400, { error: '项目名称不能为空' })
    const base = slugify(name, `project-${Date.now()}`)
    const existing = await listProjects()
    let slug = base, suffix = 2
    while (existing.some(row => row.id === slug)) slug = `${base}-${suffix++}`
    // The folder was already de-duplicated, but the DISPLAY name was not, so two
    // projects could sit in the picker under one identical label with no way to
    // tell them apart — and picking the wrong one looks exactly like data loss.
    const label = slug === base ? name : `${name}（${suffix - 1}）`
    const { folder, state } = await ensureProject(slug, { name: label })
    if (payload.sample) {
      const log = await loadSample(folder, state, typeof payload.sample === 'string' ? payload.sample : undefined)
      await saveState(folder, state, log)
    } else if (DATASETS[payload.dataset]) {
      state.project.dataset = payload.dataset
      state.project.referenceBrand = text(payload.referenceBrand, 40)
      state.project.city = DATASETS[payload.dataset].label.split(' · ')[0]
      state.project.format = text(payload.format, 40) || 'restaurant'
      await saveState(folder, state, {
        text: `设定城市数据集：${DATASETS[payload.dataset].label}${state.project.referenceBrand ? `，参照品牌 ${state.project.referenceBrand}` : ''}`,
        durable: false,
      })
    }
    return json(res, 201, { project: projectSummary(state) })
  }

  if (url.pathname === '/api/site-selection/projects/delete') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const payload = await readBody(req)
    const slug = slugify(payload.project || '')
    if (!slug) return json(res, 400, { error: '缺少 project 参数' })
    const folder = campaignFolderFor(slug)
    try { await stat(folder) } catch { return json(res, 404, { error: '项目不存在' }) }
    // Moved, never unlinked: a project folder holds field notes and decisions
    // that took real legwork, and this is one click away in a menu.
    const trash = join(DATA_ROOT, '.trash')
    await mkdir(trash, { recursive: true })
    const target = join(trash, `${slug}-${Date.now()}`)
    await rename(folder, target)
    return json(res, 200, { ok: true, movedTo: target })
  }

  if (url.pathname === '/api/site-selection/action') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const action = await readBody(req)
    const slug = slugify(action.project || '')
    if (!slug) return json(res, 400, { error: '缺少 project 参数' })
    const { folder, state } = await ensureProject(slug)
    let log
    if (action.type === 'load-sample') log = await loadSample(folder, state, action.sample)
    else if (action.type === 'set-dataset') {
      if (!DATASETS[action.dataset]) throw new Error('数据集不存在')
      state.project.dataset = action.dataset
      state.project.referenceBrand = text(action.referenceBrand, 40)
      state.project.city = DATASETS[action.dataset].label.split(' · ')[0]
      log = { text: `切换到 ${DATASETS[action.dataset].label}${state.project.referenceBrand ? ` / 参照 ${state.project.referenceBrand}` : ''}`, durable: false }
    }
    else log = applyAction(state, action)
    const { state: next, scores } = await saveState(folder, state, log)
    return json(res, 200, { ok: true, state: next, scores, log: log?.text || '' })
  }

  if (url.pathname === '/api/site-selection/datasets') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    return json(res, 200, {
      // The dataset is the demo fixture; marking it once where it is chosen is
      // the whole of the disclosure. Swapping in a licensed feed later clears it.
      datasets: Object.entries(DATASETS).map(([id, spec]) => ({
        id, label: spec.label, brands: spec.brands || [], simulated: true,
      })),
      samples: Object.entries(SAMPLES).map(([id, spec]) => ({ id, label: spec.label, blurb: spec.blurb })),
      formats: FORMATS.map(f => ({ id: f.id, label: f.label })),
    })
  }

  // Served separately from /dataset so the simulated layer stays opt-in: a
  // client that never asks for it never sees it, and nothing that computes a
  // score has any way to reach it.
  if (url.pathname === '/api/site-selection/market') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const bundle = await loadDataset(String(url.searchParams.get('name') || ''))
    if (!bundle) return json(res, 404, { error: '数据集不存在' })
    if (!bundle.market) return json(res, 404, { error: '这个城市还没有生成模拟商业数据' })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=86400' })
    return res.end(JSON.stringify(bundle.market))
  }

  if (url.pathname === '/api/site-selection/dataset') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const bundle = await loadDataset(String(url.searchParams.get('name') || ''))
    if (!bundle) return json(res, 404, { error: '数据集不存在' })
    // Fetched once by the browser and reused; it is ~1 MB and must never ride
    // along on the 3 s bootstrap poll.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=86400' })
    res.end(JSON.stringify({
      name: bundle.name, label: bundle.label, bbox: bundle.bbox, brands: bundle.brands,
      attribution: bundle.attribution, buildingNote: bundle.buildingNote,
      pois: bundle.pois, places: bundle.places, buildings: bundle.buildings, basemap: bundle.basemap,
      floorArea: bundle.floorDoc ? { grid: bundle.floorDoc.grid, coverage: bundle.floorDoc.coverage, cells: bundle.floorDoc.cells } : null,
      hasMarket: Boolean(bundle.market),
    }))
    return
  }

  if (url.pathname === '/api/site-selection/probe') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const payload = await readBody(req)
    const slug = slugify(payload.project || '')
    if (!slug) return json(res, 400, { error: '缺少 project 参数' })
    const lng = num(payload.lng), lat = num(payload.lat)
    if (lng === null || lat === null) return json(res, 400, { error: '缺少坐标' })
    const { state, pois, floorGrid, basemapIndex, availableKinds, brandPoints, index, mode, rankModel } = await ensureProject(slug)
    const point = { lng, lat, ...(num(payload.area) ? { area: num(payload.area) } : {}), ...(num(payload.rent) ? { rent: num(payload.rent) } : {}) }
    const ctx = { rivals: state.project.rivals, floorGrid, brandPoints, index, basemapIndex,
    availableKinds, format: state.project.format }
    const result = { ...rankAgainstReference(point, pois, rankModel, ctx), mode }
    return json(res, 200, { ok: true, point, result })
  }

  if (url.pathname === '/api/site-selection/file') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const { folder } = await ensureProject(projectParam(url))
    const target = resolve(folder, String(url.searchParams.get('path') || ''))
    if (target !== folder && !target.startsWith(`${folder}/`)) return json(res, 403, { error: 'invalid path' })
    const bytes = await readFile(target)
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
      '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' })[extname(target).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    res.end(bytes)
    return
  }

  return json(res, 404, { error: 'not found' })
}

export function apply(ctx) {
  const routes = [...Object.keys(ASSETS),
    '/api/site-selection/bootstrap', '/api/site-selection/projects',
    '/api/site-selection/action', '/api/site-selection/file', '/api/site-selection/projects/delete',
    '/api/site-selection/datasets', '/api/site-selection/dataset', '/api/site-selection/probe',
    '/api/site-selection/market', '/api/site-selection/watch']
  for (const path of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path,
      handler: (req, res) => handleApi(req, res).catch(error => json(res, 500, { error: error instanceof Error ? error.message : String(error) })),
    }), `dsh-site-selection: ${path}`)
  }
}

export { walkRadius, extractFeatures }
