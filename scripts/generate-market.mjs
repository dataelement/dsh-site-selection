/**
 * Generate the SIMULATED commercial-intelligence layer for a city.
 *
 * Everything in src/data is real OpenStreetMap data except the file this script
 * writes. It exists to answer the four questions the workbench otherwise states
 * outright that it cannot: 在租铺源与租金、实测客流、商场档次、客群消费力.
 *
 * Why fabricate at all, given the rest of this project refuses to:
 *   1. Every record is stamped `simulated: true` and lives in its own file,
 *      its own endpoint and its own UI layer. It never reaches the score.
 *   2. The SCHEMA is the real deliverable. Each table names, in `vendors`, the
 *      companies that actually sell this data in China. Buying it later means
 *      filling the same shape — nothing above this layer changes.
 *
 * Values are conditioned on the real OSM features of each location, not drawn
 * at random, so the demo cannot produce a 300 元/㎡ pitch next to 国贸. The one
 * deliberate exception is footfall, which carries a large idiosyncratic term —
 * see FOOTFALL below for why that term is the whole point of paying for it.
 *
 *   node scripts/generate-market.mjs beijing
 *   node scripts/generate-market.mjs shanghai
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  indexPois, indexFloorGrid, indexBasemap, floorAreaWithin, queryRadius,
  nearestOfKind, streetFeatures, haversine,
} from '../src/model.js'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')

const CITIES = {
  beijing: {
    poi: 'beijing-poi.json', floor: 'beijing-floorarea.json', basemap: 'beijing-basemap.json',
    label: '北京 · 五环内及望京亦庄', listings: 2700, seed: 20260907,
    // Ground rent level, 元/㎡/天 street retail. Calibrated so core Chaoyang
    // lands at 12–20 and 社区底商 at 4–7, which is where the市场 actually sits.
    rentBase: 3.0,
  },
  guangzhou: {
    poi: 'guangzhou-poi.json', floor: 'guangzhou-floorarea.json', basemap: 'guangzhou-basemap.json',
    label: '广州 · 主城区', listings: 1300, seed: 20260909,
    rentBase: 2.6,
  },
  shanghai: {
    poi: 'shanghai-poi.json', floor: 'shanghai-floorarea.json', basemap: 'shanghai-basemap.json',
    label: '上海 · 外环内', listings: 1900, seed: 20260908,
    rentBase: 3.6,
  },
}

const VENDORS = {
  listings: '58同城 / 铺客多 / 赢商网铺源库；高端物业走第一太平戴维斯、世邦魏理仕等行代理',
  footfall: '极海纵横 / 百度慧眼 / 高德位智 / 联通智慧足迹；客单价来自银联商务、美团开放平台',
  malls: '赢商网 / RET睿意德 / 联商网',
}

// ── seeded RNG so a regenerated file is byte-identical ──
// Listing ids are positional (lst-0001 is the first generated), so the RNG
// stream IS the identity of every listing. Adding a draw in the middle of the
// loop renumbers everything after it, and any site a user already adopted then
// points at a different unit. New attributes therefore get their own generator
// and their own pass — see the gas pass below.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rnd = mulberry32(1)
const uniform = (lo, hi) => lo + rnd() * (hi - lo)
const pick = list => list[Math.floor(rnd() * list.length)]
const chance = p => rnd() < p
/** Box–Muller, so the tails look like a market rather than a slider range. */
function normal(mean = 0, sd = 1) {
  const u = Math.max(rnd(), 1e-9), v = Math.max(rnd(), 1e-9)
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const logNormal = (median, sigma) => median * Math.exp(normal(0, sigma))
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const round = (x, step = 1) => Math.round(x / step) * step

// ── vocabulary ──
// `gas` is the chance a unit with this history has a municipal gas connection.
// A 正餐 kitchen almost always did; a phone shop almost never does, and getting
// one installed afterwards is a municipal application, not a renovation task.
const FORMER_USE = [
  { name: '餐饮（正餐）', food: true, w: 14, gas: 0.82 },
  { name: '奶茶咖啡', food: true, w: 12, gas: 0.22 },
  { name: '快餐小吃', food: true, w: 13, gas: 0.68 },
  { name: '烘焙', food: true, w: 5, gas: 0.45 },
  { name: '便利店', food: false, w: 9, gas: 0.18 },
  { name: '服装零售', food: false, w: 10, gas: 0.08 },
  { name: '美容美发', food: false, w: 8, gas: 0.12 },
  { name: '药店', food: false, w: 4, gas: 0.06 },
  { name: '教培', food: false, w: 5, gas: 0.07 },
  { name: '手机数码', food: false, w: 4, gas: 0.05 },
  { name: '空置（毛坯）', food: false, w: 9, raw: true, gas: 0.14 },
  { name: '空置（原餐饮）', food: true, w: 7, raw: false, gas: 0.7 },
]
// Channel describes HOW the unit is on the market. It deliberately does not
// name a real platform: these listings do not exist, and attributing them to a
// named company would be inventing that company's records.
const CHANNELS = ['业主直租', '中介挂牌', '门店转让', '物业招商', '平台挂牌']
const AGENTS = ['中介 A', '中介 B', '中介 C', '中介 D', '业主自持', '商管公司']

/**
 * Malls whose positioning is publicly known, matched by keyword.
 * Checked highest tier first, first match wins. This is the one place the
 * generator uses real-world knowledge rather than deriving from OSM — because
 * a demo that calls 北京SKP a mid-market mall is not a credible demo.
 */
const TIER_ANCHORS = [
  ['高端', ['SKP', '国金中心', 'iapm', '嘉里中心', '芮欧', 'K11', '侨福芳草地', '王府中环',
    '银泰in88', '燕莎友谊', '中信富泰', '梅龙镇', '新天地时尚', '恒隆', '太古', '国贸', '中国世界']],
  ['中高端', ['大悦城', '合生汇', '颐堤港', '世茂工三', '来福士', 'apm', '东方新天地', '万象汇',
    '印象城', '正大广场', '上海商城', '日月光', '湖滨道', '巴黎春天', '新世界城', 'Solana',
    '时代广场', '万科时代中心', '摩方', '西单更新场', '晶品', '无限极荟']],
  ['大众', ['万达', '新世界百货', '百盛', '西单购物中心', '华联', '京东MALL', '苏宁', '国美',
    '永安百货', '中央商场', '新中关', '奥特莱斯']],
  ['社区', ['市场', '茶城', '珠宝城', '便民', '生活广场', '生活MALL', '商城', '大厦', '商厦']],
]

const MALL_TIERS = [
  { name: '高端', gfa: [80000, 260000], ticket: 1.55, vacancy: [0.02, 0.08], rent: [22, 48] },
  { name: '中高端', gfa: [60000, 180000], ticket: 1.2, vacancy: [0.04, 0.12], rent: [14, 28] },
  { name: '大众', gfa: [35000, 120000], ticket: 0.92, vacancy: [0.07, 0.18], rent: [8, 18] },
  { name: '社区', gfa: [12000, 60000], ticket: 0.72, vacancy: [0.09, 0.25], rent: [5, 12] },
]

const tierAnchor = name => {
  for (const [tier, keys] of TIER_ANCHORS) {
    if (keys.some(k => name.includes(k))) return MALL_TIERS.find(t => t.name === tier)
  }
  return null
}

const weighted = list => {
  const total = list.reduce((a, x) => a + x.w, 0)
  let r = rnd() * total
  for (const x of list) { r -= x.w; if (r <= 0) return x }
  return list[list.length - 1]
}

const M_PER_DEG_LAT = 111320
const mPerDegLng = lat => 111320 * Math.cos((lat * Math.PI) / 180)

async function main() {
  const city = process.argv[2]
  const spec = CITIES[city]
  if (!spec) throw new Error(`用法: node scripts/generate-market.mjs <${Object.keys(CITIES).join('|')}>`)
  rnd = mulberry32(spec.seed)

  const read = async f => JSON.parse(await readFile(join(DATA, f), 'utf8'))
  const poiDoc = await read(spec.poi)
  const floorDoc = await read(spec.floor)
  const baseDoc = await read(spec.basemap)

  const pois = poiDoc.pois
  const index = indexPois(pois)
  const floorGrid = indexFloorGrid(floorDoc)
  const basemapIndex = indexBasemap({ areas: baseDoc.areas, roads: baseDoc.roads })

  /** Everything the rent and footfall models are allowed to see. */
  const observe = point => {
    const density = floorAreaWithin(point, floorGrid, 500)
    const metro = nearestOfKind(index, point, 'metro_exit') || nearestOfKind(index, point, 'metro')
    const near = (kind, r) => (queryRadius(index, point, r, kind) || []).length
    return {
      density: Number.isFinite(density) ? density : null,
      metroDist: metro ? Math.round(metro.d) : null,
      metroExits: near('metro_exit', 400),
      food: near('food', 500),
      mall: near('mall', 300),
      office: near('office', 500),
      resident: near('residential', 500),
      school: near('school', 500) + near('campus', 1500),
    }
  }

  // ══ MALLS ══════════════════════════════════════════════
  const malls = pois.filter(p => p.kind === 'mall' && p.name).map((m, i) => {
    const o = observe(m)
    const prime = clamp(Math.log10(Math.max(o.density || 50000, 30000) / 120000), 0, 1.2)
      + (o.metroDist !== null && o.metroDist < 250 ? 0.5 : 0)
    // Density and transit alone put 北京SKP at 中高端 and 侨福芳草地 at 大众,
    // which anyone who lives in the city spots immediately and stops believing
    // the rest of the page. Positioning is public knowledge, so it is anchored;
    // footfall, vacancy and rent stay simulated.
    const anchored = tierAnchor(m.name)
    const tier = anchored || MALL_TIERS[clamp(Math.round(3 - prime * 2 + normal(0, 0.55)), 0, 3)]
    const gfa = round(uniform(tier.gfa[0], tier.gfa[1]), 1000)
    const openedYear = Math.round(clamp(normal(2013, 7), 1994, 2025))
    return {
      id: `mall-${(i + 1).toString().padStart(3, '0')}`,
      simulated: true,
      name: m.name, lng: m.lng, lat: m.lat,
      tier: tier.name,
      openedYear,
      gfaSqm: gfa,
      dailyFootfall: Math.round(clamp(gfa * uniform(0.11, 0.34) * (1 + prime), 1200, 130000)),
      vacancyRate: +(clamp(uniform(tier.vacancy[0], tier.vacancy[1])
        + (2026 - openedYear > 15 ? 0.04 : 0), 0.01, 0.35)).toFixed(3),
      rentPerSqmDay: [tier.rent[0], tier.rent[1]],
      foodCourtFloors: pick([['B1'], ['B1', '4F'], ['5F'], ['B1', '5F', '6F'], ['3F', '4F']]),
      anchorCategories: [...new Set(Array.from({ length: 3 },
        () => pick(['快时尚', '轻奢', '影院', '超市', '亲子', '餐饮', '运动', '美妆', '数码', '书店'])))],
      teaCoffeeBrands: Math.round(clamp(normal(gfa / 12000, 2.5), 0, 26)),
      tierSource: anchored ? '真实定位' : '按密度与地铁估算',
      note: '客流、空置率、租金区间均为模拟值'
        + (anchored ? '；档次按公开定位标注' : '；档次为估算'),
    }
  })

  /**
   * Rent per ㎡ per day — the unit Chinese retail leasing actually quotes.
   * Built from density, subway proximity and the tier of the neighbouring mall;
   * the lognormal term is the spread between a corner unit and a back-alley one
   * on the same block.
   *
   * A flat "+2.8 if any mall within 300 m" could not tell 恒隆广场 from a
   * community mall, so the model ranked 人民广场 above 南京西路 — it could see
   * density and transit but not what actually sits on the street. Defined after
   * the mall block because it now reads from it.
   */
  const TIER_RENT = { 高端: 6.2, 中高端: 3.8, 大众: 2.0, 社区: 0.9 }
  const mallRentPull = point => {
    let best = 0
    for (const m of malls) {
      const d = haversine(point, m)
      if (d > 700) continue
      const v = TIER_RENT[m.tier] * Math.exp(-d / 320)
      if (v > best) best = v
    }
    return best
  }
  const nearestMallTier = point => {
    let best = null
    for (const m of malls) {
      const d = haversine(point, m)
      if (d <= 300 && (!best || d < best.d)) best = { d, tier: m.tier }
    }
    return best?.tier || null
  }

  const rentPerSqmDay = (o, point) => {
    const density = clamp(Math.log10(Math.max(o.density || 50000, 20000) / 100000), 0, 1.25)
    const metro = o.metroDist === null ? 0.15 : Math.exp(-o.metroDist / 400)
    const buzz = clamp(Math.log10(Math.max(o.food, 1)) / 2, 0, 1)
    const raw = spec.rentBase + 4.6 * density + 5.0 * metro + mallRentPull(point) + 1.6 * buzz
    return clamp(raw * Math.exp(normal(0, 0.26)), 1.8, 52)
  }

  // ══ LISTINGS ═══════════════════════════════════════════
  // Anchored on real commercial addresses: a unit for rent sits where retail
  // already is, and a real road name makes the address usable in the demo.
  // Named anchors only: "近三里屯太古里" is how a listing gets described to a
  // client, and an unnamed one leaves that field blank in the demo.
  // Anchors follow the category split. Left on the old four names this found a
  // quarter of the addresses it should, because `food` no longer exists.
  const ANCHOR_KINDS = ['restaurant', 'fastfood', 'cafe', 'teadrink', 'bakery', 'dessert', 'bar',
    'supermarket', 'convenience', 'mall', 'clothes', 'cosmetics', 'pharmacy', 'books',
    'electronics', 'hairdresser', 'food']
  const anchors = pois.filter(p => ANCHOR_KINDS.includes(p.kind) && Number.isFinite(p.lng) && p.name)
  const listings = []
  const seen = new Set()
  let guard = 0
  while (listings.length < spec.listings && guard < spec.listings * 40) {
    guard += 1
    const anchor = pick(anchors)
    const key = anchor.id
    if (seen.has(key)) continue
    seen.add(key)

    // Jitter off the anchor: the vacant unit is next door, not inside the shop.
    const jitter = 60
    const point = {
      lng: +(anchor.lng + (normal(0, jitter) / mPerDegLng(anchor.lat))).toFixed(6),
      lat: +(anchor.lat + (normal(0, jitter) / M_PER_DEG_LAT)).toFixed(6),
    }
    const o = observe(point)
    const street = streetFeatures(point, basemapIndex)
    const inMall = o.mall > 0 && chance(0.45)

    const former = weighted(FORMER_USE)
    const areaSqm = round(clamp(logNormal(inMall ? 95 : 68, 0.52), 18, 420), 1)
    // An in-mall unit rents above the street around it, and by how much depends
    // on the mall: a 高端 mall commands a real premium, a 社区 one barely any.
    const mallTier = inMall ? (nearestMallTier(point) || '大众') : null
    const IN_MALL_MULT = { 高端: 1.62, 中高端: 1.42, 大众: 1.22, 社区: 1.06 }
    const perDay = rentPerSqmDay(o, point) * (inMall ? IN_MALL_MULT[mallTier] : 1)
    const floor = inMall
      ? pick([1, 1, 1, 2, 2, 3, -1])
      : (chance(0.76) ? 1 : chance(0.6) ? 2 : -1)
    // Upper and basement floors let for materially less than street level.
    const floorFactor = floor === 1 ? 1 : floor === 2 ? 0.62 : floor === -1 ? 0.55 : 0.48
    const rentPerMonth = round(perDay * floorFactor * areaSqm * 30, 100)

    const isFoodReady = former.food
    const hasFlue = floor > 2 ? chance(0.25) : isFoodReady ? chance(0.92) : chance(0.28)
    const hasWater = isFoodReady ? chance(0.94) : chance(0.55)
    const canLicense = hasFlue && hasWater ? chance(0.88) : chance(0.2)

    listings.push({
      id: `lst-${(listings.length + 1).toString().padStart(4, '0')}`,
      simulated: true,
      lng: point.lng,
      lat: point.lat,
      address: street.roadName
        ? `${street.roadName}${round(uniform(1, 320), 1)}号${inMall ? `（${anchor.name || '商场'}内）` : ''}`
        : `${anchor.name || '未命名地点'}附近`,
      nearby: anchor.name || '',
      inMall,
      mallTier,
      areaSqm,
      floor,
      rentPerMonth,
      rentPerSqmDay: +(rentPerMonth / areaSqm / 30).toFixed(2),
      // 转让费 is a Chinese-market fact with no Western equivalent: the outgoing
      // tenant sells the fit-out and the queue. Fully-fitted food units carry it,
      // shells usually do not.
      transferFee: former.raw ? 0
        : chance(0.36) ? 0
          : round(clamp(logNormal(rentPerMonth * 3.2, 0.7), 8000, 1600000), 1000),
      propertyFeePerSqm: +(uniform(inMall ? 14 : 4, inMall ? 42 : 16)).toFixed(1),
      freeRentDays: round(clamp(normal(inMall ? 60 : 32, 22), 0, 150), 5),
      leaseYears: pick([3, 3, 5, 5, 5, 8]),
      increaseRatePct: +(uniform(3, 8)).toFixed(1),
      frontageM: inMall ? null : +(clamp(Math.sqrt(areaSqm) * uniform(0.5, 0.95), 2.4, 20)).toFixed(1),
      ceilingM: +(clamp(normal(inMall ? 4.6 : 3.5, 0.7), 2.5, 7.5)).toFixed(1),
      powerKw: round(clamp(logNormal(areaSqm * 0.42, 0.5), 6, 260), 1),
      hasFlue,
      hasWater,
      canLicense,
      formerGas: former.gas,      // consumed by the gas pass, deleted there
      independentDoor: inMall ? false : floor === 1 ? chance(0.78) : chance(0.3),
      formerUse: former.name,
      vacantMonths: round(clamp(logNormal(former.raw ? 6 : 3, 0.8), 0, 42), 1),
      channel: pick(CHANNELS),
      agent: pick(AGENTS),
      status: chance(0.86) ? '在租' : chance(0.5) ? '已租出' : '已下架',
      postedDaysAgo: round(clamp(logNormal(26, 0.9), 1, 400), 1),
    })
  }

  // ── gas: a second pass on its own stream ──
  // Malls overwhelmingly ban open flame for new F&B tenants and run all-electric;
  // a basement rarely gets a gas riser. Both dominate whatever the unit used to
  // be. Drawn here rather than inline so adding this field did not renumber
  // every listing and invalidate already-adopted ones.
  const gasRnd = mulberry32(spec.seed ^ 0x9e3779b9)
  for (const l of listings) {
    const odds = l.formerGas * (l.inMall ? 0.16 : 1) * (l.floor === -1 ? 0.3 : 1) * (l.floor > 2 ? 0.5 : 1)
    l.hasGas = gasRnd() < odds
    delete l.formerGas
  }

  // ══ FOOTFALL ═══════════════════════════════════════════
  // The idiosyncratic term is deliberately large (σ≈0.45 lognormal, roughly a
  // third of the variance). If measured footfall were a clean function of
  // building density, the workbench's free proxy would already answer it and
  // there would be no reason to buy this table — the value of the product is
  // exactly the part you cannot derive.
  const CELL = 0.0025
  const cellsSeen = new Map()
  const bbox = poiDoc.bbox
  for (let lat = bbox.minLat; lat <= bbox.maxLat; lat += CELL) {
    for (let lng = bbox.minLng; lng <= bbox.maxLng; lng += CELL) {
      const point = { lng: +(lng + CELL / 2).toFixed(6), lat: +(lat + CELL / 2).toFixed(6) }
      const o = observe(point)
      if (!o.density || o.density < 30000) continue          // nothing there to count
      if (o.food + o.office + o.resident + o.mall === 0) continue

      const density = Math.pow(o.density / 100000, 0.58)
      const transit = 1 + 0.42 * Math.min(o.metroExits, 5)
      const retail = 1 + 0.30 * clamp(Math.log10(Math.max(o.food, 1)), 0, 2) + 0.5 * Math.min(o.mall, 2)
      const idio = Math.exp(normal(0, 0.45))
      const daily = Math.round(clamp(2600 * density * transit * retail * idio, 300, 420000))

      // Offices empty at weekends; malls fill up. Both pull on the same cell and
      // the mall has to be able to win, or a shopping centre reads as a weekday
      // office block — which is what happened to 望京万象汇 on the first pass.
      const workerPull = o.office / (o.office + o.resident + 1)
      const mallPull = Math.min(o.mall, 2) / 2
      const weekdayRatio = clamp(0.92 + 0.48 * workerPull - 0.42 * mallPull, 0.68, 1.35)
      const weekday = Math.round(daily * weekdayRatio)
      const weekend = Math.round(daily * clamp(2 - weekdayRatio, 0.65, 1.32))

      const peaks = mallPull > 0.4 ? ['14:00', '16:30', '19:30']
        : workerPull > 0.5 ? ['08:30', '12:00', '18:30']
          : ['08:00', '18:00', '20:00']

      const wResident = o.resident + 1, wWorker = o.office * 1.3 + 1
      const wPassing = (o.mall * 20 + o.metroExits * 14 + o.food * 0.6 + 1)
      const total = wResident + wWorker + wPassing
      const share = x => Math.round((x / total) * 100)

      cellsSeen.set(`${point.lng},${point.lat}`, {
        lng: point.lng, lat: point.lat,
        daily, weekday, weekend, peaks,
        mix: { resident: share(wResident), worker: share(wWorker), passing: share(wPassing) },
        dwellMin: round(clamp(normal(o.mall > 0 ? 52 : 19, 12), 5, 130), 1),
        // 客单价 by category — what 银联/美团 sell. Correlated with rent level
        // but not identical to it: a dense office block has high rent and
        // mid-range tickets.
        avgTicket: (() => {
          const wealth = clamp(0.55 + 0.5 * Math.log10(Math.max(o.density, 30000) / 200000)
            + normal(0, 0.16), 0.5, 2.0)
          return {
            咖啡: round(26 * wealth, 1), 茶饮: round(17 * wealth, 1),
            快餐: round(31 * wealth, 1), 烘焙: round(24 * wealth, 1),
            正餐: round(82 * wealth, 1),
          }
        })(),
      })
    }
  }
  const footfall = [...cellsSeen.values()]

  const out = {
    simulated: true,
    warning: '本文件全部为模拟数据，不是任何真实交易、测量或企业记录。仅用于演示「买到商业数据之后工作台长什么样」。',
    city, label: spec.label,
    generator: 'scripts/generate-market.mjs',
    seed: spec.seed,
    generatedAt: new Date().toISOString(),
    vendors: VENDORS,
    schemaNote: '字段命名对齐国内数据商实际售卖的口径；替换为真实采购数据时保持同一 schema 即可，上层无需改动。',
    coverage: bbox,
    counts: { listings: listings.length, footfall: footfall.length, malls: malls.length },
    listings, footfall, malls,
  }
  const path = join(DATA, `${city}-market.json`)
  await writeFile(path, JSON.stringify(out), 'utf8')

  const rents = listings.map(l => l.rentPerSqmDay).sort((a, b) => a - b)
  const q = t => rents[Math.floor(rents.length * t)]
  const daily = footfall.map(f => f.daily).sort((a, b) => a - b)
  const dq = t => daily[Math.floor(daily.length * t)]
  console.log(`■ ${city}-market.json  ${spec.label}`)
  console.log(`  铺源 ${listings.length}　租金 元/㎡/天  p10 ${q(0.1)}  中位 ${q(0.5)}  p90 ${q(0.9)}`)
  console.log(`  客流网格 ${footfall.length}　日均  p10 ${dq(0.1)}  中位 ${dq(0.5)}  p90 ${dq(0.9)}`)
  const byTier = {}
  for (const m of malls) byTier[m.tier] = (byTier[m.tier] || 0) + 1
  console.log(`  商场 ${malls.length}　${Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join('，')}`)
}

main().catch(e => { console.error(e.message); process.exit(1) })
