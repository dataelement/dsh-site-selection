/**
 * Pure siting logic: geometry, feature extraction, brand-model fitting, scoring.
 * No I/O, no DSH — everything here is unit-testable and is the part a domain
 * expert should review.
 */

const EARTH_R = 6371000
const rad = deg => (deg * Math.PI) / 180

/** Great-circle distance in metres between two {lng, lat} points. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Catchment radius for a walking-minutes budget: 80 m/min, 0.75 street-network factor. */
export const walkRadius = minutes => Math.round(minutes * 80 * 0.75)

export const DISTRICT_TYPES = ['商场', '写字楼', '社区', '混合街铺']

/**
 * Feature vocabulary. `lowerBetter` only documents the natural direction — the
 * brand model never assumes it, it learns the direction from the operator's own
 * stores, because a brand that lives on office lunch traffic and one that lives
 * on late-night residential traffic want opposite things from the same number.
 */
export const NUMERIC_FEATURES = [
  { key: 'metroDist', label: '最近地铁出入口距离', unit: 'm', lowerBetter: true },
  { key: 'food500', label: '500m 内餐饮总数（集聚度）', unit: '家' },
  { key: 'rival500', label: '500m 内同业态竞品', unit: '家', lowerBetter: true },
  { key: 'office500', label: '500m 内办公点（日间人口代理）', unit: '处' },
  { key: 'residential800', label: '800m 内住宅楼（夜间人口代理）', unit: '栋' },
  { key: 'mall300', label: '300m 内商场', unit: '个' },
  { key: 'frontage', label: '临街面宽', unit: 'm' },
  { key: 'area', label: '铺面面积', unit: '㎡' },
  // Rent is an OUTCOME of location quality, not an attribute of it: good pitches
  // command high rent, so fitting on it yields "pay more, earn more", which is
  // endogeneity, not advice. Computed and shown, never fitted.
  { key: 'rentPerSqm', label: '租金单价', unit: '元/㎡/月', lowerBetter: true, endogenous: true },
]

const within = (pois, center, radius, kind, index) =>
  (index ? queryRadius(index, center, radius, kind)
         : pois.filter(poi => poi.kind === kind && haversine(center, poi) <= radius))

/** Does this POI compete with us? Matched by brand name first, then cuisine tag. */
function isRival(poi, rivals) {
  if (!FOOD_KINDS.includes(poi.kind)) return false
  const brands = rivals?.brands || []
  const cuisines = rivals?.cuisines || []
  const name = String(poi.name || '')
  if (brands.length && brands.some(brand => brand && name.includes(brand))) return true
  if (cuisines.length && cuisines.some(c => c && String(poi.cuisine || '').includes(c))) return true
  return false
}

/** Classify the trade area from what is actually around the point. */
export function districtType({ mall300, office500, residential800 }) {
  if (mall300 >= 1) return '商场'
  const ratio = office500 / (office500 + residential800 + 1)
  if (ratio > 0.55) return '写字楼'
  if (ratio < 0.22) return '社区'
  return '混合街铺'
}

/**
 * Everything the model knows about a point: what surrounds it, plus the shop's
 * own physical facts. Own-store proximity is included so cannibalisation is
 * visible rather than discovered after signing.
 */
export function extractFeatures(point, pois, options = {}) {
  const { rivals, index } = options
  const nearestMetro = index
    ? (nearestOfKind(index, point, 'metro_exit') || nearestOfKind(index, point, 'metro'))
    : pois.filter(poi => poi.kind === 'metro' || poi.kind === 'metro_exit')
        .reduce((best, poi) => {
          const d = haversine(point, poi)
          return !best || d < best.d ? { d, item: poi } : best
        }, null)

  // `food` was one kind and is now seven; sum them so 餐饮集聚度 keeps meaning
  // the same thing across datasets fetched before and after the split.
  const food500 = FOOD_KINDS.flatMap(k => within(pois, point, 500, k, index))
  const rival500 = food500.filter(poi => isRival(poi, rivals))
  const office500 = within(pois, point, 500, 'office', index)
  const residential800 = within(pois, point, 800, 'residential', index)
  const mall300 = within(pois, point, 300, 'mall', index)

  const base = {
    metroDist: nearestMetro ? Math.round(nearestMetro.d) : null,
    metroName: nearestMetro?.poi?.name || nearestMetro?.poi?.line || '',
    food500: food500.length,
    rival500: rival500.length,
    office500: office500.length,
    residential800: residential800.length,
    mall300: mall300.length,
    frontage: Number.isFinite(point.frontage) ? point.frontage : null,
    area: Number.isFinite(point.area) ? point.area : null,
    rentPerSqm: Number.isFinite(point.rent) && point.area > 0 ? Math.round(point.rent / point.area) : null,
  }
  base.districtType = districtType(base)
  return base
}

function pearson(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Two-tailed p<0.05 critical t for df, accurate to ~0.005 over df 5..60. */
export function criticalT(df) {
  if (df < 3) return Infinity
  return 1.96 + 2.37 / df + 3.8 / (df * df)
}

/**
 * Two-tailed p<0.05 critical |r| for a sample of n. Small samples throw up
 * spurious correlations constantly, so nothing becomes a claim without clearing
 * this bar first.
 */
export function criticalR(n) {
  const df = n - 2
  if (df < 3) return 1
  const t = criticalT(df)
  return t / Math.sqrt(t * t + df)
}

/** Sample size drives how loudly the model is allowed to speak. */
export function confidenceOf(n) {
  if (n >= 20) return { level: 'high', label: '高', note: `${n} 个样本，充分` }
  if (n >= 8) return { level: 'medium', label: '中', note: `${n} 个样本，有参考价值但不宜绝对` }
  return { level: 'low', label: '低', note: `仅 ${n} 个样本，不足，结论仅供参考` }
}

/**
 * What no dataset can answer.
 *
 * These are the criteria that decide a lease and that OpenStreetMap, or any
 * other purchasable location dataset, simply does not contain. They are listed
 * rather than quietly omitted, because a score built only from what happened to
 * be measurable reads as if it covered everything.
 *
 * `blocker` fields exclude the site outright when answered false — no amount of
 * footfall compensates for a shop that cannot vent a kitchen. `measure` fields
 * are recorded and displayed but never scored: with no baseline to rank them
 * against, a percentile would be fiction. `boolean` fields are tracked like a
 * blocker but never exclude, because whether they matter depends on the format.
 */
export const FIELD_CHECKS = [
  { key: 'hasFlue', kind: 'blocker', label: '排烟条件', ask: '有没有专用烟道？',
    fail: '无排烟条件，热厨餐饮无法落位' },
  { key: 'canLicense', kind: 'blocker', label: '食品经营许可', ask: '能不能办食品经营许可？',
    fail: '无法办理食品经营许可' },
  { key: 'hasWater', kind: 'blocker', label: '上下水', ask: '有没有独立上下水？',
    fail: '无独立上下水，餐饮无法落位' },
  // Not a blocker, and that distinction is the whole reason this kind exists:
  // 茶饮 and 咖啡 are all-electric and do not care, while 正餐 and 火锅 cannot
  // open without it. Auto-excluding on it would have killed perfectly good
  // tea-shop pitches. Recorded and shown; the operator decides.
  { key: 'hasGas', kind: 'boolean', label: '市政燃气',
    ask: '有没有市政燃气？' },
  { key: 'powerKw', kind: 'measure', label: '电力容量', unit: 'kW',
    ask: '报装容量多少 kW？' },
  { key: 'ceilingM', kind: 'measure', label: '层高', unit: 'm',
    ask: '净层高多少米？' },
  { key: 'frontage', kind: 'measure', label: '临街面宽', unit: 'm',
    ask: '门脸宽多少米？' },
  { key: 'area', kind: 'measure', label: '建筑面积', unit: '㎡', ask: '多少平？' },
  { key: 'floor', kind: 'measure', label: '所在楼层', ask: '几层？' },
  { key: 'rent', kind: 'measure', label: '月租金', unit: '元/月',
    ask: '月租多少？免租期、递增？' },
  // As much a "you have to ask" number as the rent, and often the larger cheque
  // on day one. 0 is a real answer, not a blank.
  { key: 'transferFee', kind: 'measure', label: '转让费', unit: '元',
    ask: '转让费多少？没有填 0。' },
]

/** Restaurants have physical prerequisites no amount of foot traffic compensates for. */
export const HARD_RULES = FIELD_CHECKS.filter(c => c.kind === 'blocker')

/**
 * Split the field checks into what has been answered and what has not.
 * The gap list is the honest half of every report: it says how much of the
 * decision the workbench is actually covering.
 */
export function fieldStatus(point = {}) {
  const known = [], gaps = []
  for (const check of FIELD_CHECKS) {
    const value = point[check.key]
    const answered = check.kind === 'measure'
      ? Number.isFinite(value)
      : typeof value === 'boolean'
    ;(answered ? known : gaps).push({ ...check, value: answered ? value : null })
  }
  return { known, gaps, coverage: Math.round((known.length / FIELD_CHECKS.length) * 100) }
}

/**
 * Score one candidate against the brand model.
 * Returns a tier plus the reasons behind it — never a bare number, and never a
 * recommendation to sign. `conflicts` is the important field: a point whose
 * numbers look good while sitting in a trade-area type this brand is bad at.
 */
export const TIER_LABEL = { visit: '推荐踩点', maybe: '待定', no: '不建议', unknown: '缺少画像' }


// ══════════════════════════════════════════════════════════
//  Revealed preference: what a brand's OWN store locations say
//
//  The yield model above needs the operator's revenue, which someone opening
//  their first shop does not have. But an established chain has already made
//  the decision hundreds of times, and those locations are public. Comparing
//  where the brand IS against where *other* shops in the same category are
//  isolates the brand's specific taste rather than restating "shops are in
//  commercial areas".
// ══════════════════════════════════════════════════════════

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const variance = (xs, m) => (xs.length < 2 ? 0 : xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))

/** Welch's t-test — the two groups have very different sizes and spreads. */
function welch(a, b) {
  if (a.length < 3 || b.length < 3) return null
  const ma = mean(a), mb = mean(b)
  const va = variance(a, ma), vb = variance(b, mb)
  const se = Math.sqrt(va / a.length + vb / b.length)
  if (!(se > 0)) return null
  const t = (ma - mb) / se
  const df = (va / a.length + vb / b.length) ** 2
    / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1))
  const pooled = Math.sqrt((va + vb) / 2)
  return { t, df, ma, mb, d: pooled > 0 ? (ma - mb) / pooled : 0, significant: Math.abs(t) >= criticalT(df) }
}

/**
 * Fit "what this brand looks for" from where its shops actually are.
 * @param brandPoints  the brand's own locations
 * @param background   comparable locations of the same category, other brands
 */
export function fitRevealedModel(brandPoints, background, pois, options = {}) {
  const n = brandPoints.length
  const confidence = confidenceOf(n)
  if (n < 8 || background.length < 8) {
    return { ready: false, kind: 'revealed', sampleSize: n, confidence, features: [], districts: [], statements: [],
      reason: `参照品牌门店 ${n} 家、同类对照 ${background.length} 家，样本不足（各需至少 8 家）` }
  }

  const fb = brandPoints.map(p => extractFeatures(p, pois, options))
  const fg = background.map(p => extractFeatures(p, pois, options))

  const features = []
  for (const spec of NUMERIC_FEATURES) {
    if (spec.endogenous || ['area', 'frontage', 'rentPerSqm'].includes(spec.key)) continue
    const a = fb.map(f => f[spec.key]).filter(Number.isFinite)
    const b = fg.map(f => f[spec.key]).filter(Number.isFinite)
    const test = welch(a, b)
    if (!test) continue
    const sorted = [...a].sort((x, y) => x - y)
    features.push({
      key: spec.key, label: spec.label, unit: spec.unit,
      brandMean: Math.round(test.ma * 10) / 10,
      backgroundMean: Math.round(test.mb * 10) / 10,
      ratio: test.mb !== 0 ? Number((test.ma / test.mb).toFixed(2)) : null,
      d: Number(test.d.toFixed(2)),
      t: Number(test.t.toFixed(2)),
      significant: test.significant,
      n: a.length,
      weight: test.significant ? Number(Math.min(1, Math.abs(test.d) / 1.2).toFixed(3)) : 0,
      direction: test.t >= 0 ? 'higher' : 'lower',
      band: { low: quantile(sorted, 0.25), median: quantile(sorted, 0.5), high: quantile(sorted, 0.75) },
    })
  }
  features.sort((a, b) => (b.significant - a.significant) || Math.abs(b.d) - Math.abs(a.d))

  // Trade-area preference: share of the brand in each type vs the category's share.
  const shareOf = (rows, type) => rows.filter(f => f.districtType === type).length / rows.length
  const districts = DISTRICT_TYPES.map(type => {
    const count = fb.filter(f => f.districtType === type).length
    if (!count) return { type, count: 0, lift: 0, rawLift: 0, shrunk: true }
    const raw = shareOf(fg, type) > 0 ? shareOf(fb, type) / shareOf(fg, type) - 1 : 0
    return {
      type, count,
      brandShare: Number(shareOf(fb, type).toFixed(3)),
      categoryShare: Number(shareOf(fg, type).toFixed(3)),
      rawLift: Number(raw.toFixed(3)),
      lift: Number((raw * (count / (count + 3))).toFixed(3)),
      shrunk: count < 10,
    }
  }).filter(d => d.count > 0)

  return {
    ready: true, kind: 'revealed', sampleSize: n, backgroundSize: background.length, confidence,
    features, districts,
    statements: describeRevealed(features, districts, options.brandLabel || '参照品牌', n, background.length),
    fittedAt: new Date().toISOString(),
  }
}

function describeRevealed(features, districts, label, n, bg) {
  const out = [`基于 ${label} 在本地的 ${n} 家门店，与同类 ${bg} 家咖啡店对照。这是它自己做过 ${n} 次选址决策后暴露出来的偏好。`]
  for (const f of features.filter(x => x.significant).slice(0, 4)) {
    const dir = f.direction === 'higher' ? '更多' : '更少'
    const times = f.ratio && f.ratio > 0 && Number.isFinite(f.ratio)
      ? `${f.ratio >= 1 ? f.ratio : Number((1 / f.ratio).toFixed(2))} 倍`
      : ''
    out.push(`${label}门店周边的「${f.label}」明显${dir}：平均 ${f.brandMean} ${f.unit}，同类咖啡店平均 ${f.backgroundMean}${times ? `（${times}）` : ''}。它的门店集中在 ${Math.round(f.band.low)}–${Math.round(f.band.high)} ${f.unit}。`)
  }
  const top = districts.filter(d => d.count >= 5).sort((a, b) => b.rawLift - a.rawLift)[0]
  if (top && top.rawLift > 0.15) {
    out.push(`商圈类型上，${label}在${top.type}的占比是同类咖啡店的 ${(1 + top.rawLift).toFixed(2)} 倍（${top.count} 家）。`)
  }
  const dropped = features.filter(f => !f.significant && Math.abs(f.d) >= 0.25)
  if (dropped.length) {
    out.push(`未采信：${dropped.map(f => f.label).join('、')} 的差异在当前样本量下达不到统计显著。`)
  }
  return out
}



// ══════════════════════════════════════════════════════════
//  Reference benchmarking — the scoring the workbench actually uses
//
//  "Is this pitch any good?" is answerable without a discriminating model:
//  rank it against the places that already host a shop, or against where a
//  chosen brand chose to be. No p-values needed, just the distribution — and it
//  says something concrete on the very first click.
// ══════════════════════════════════════════════════════════

/** Floor area (m², footprint x storeys) within `radius`, from a 100 m grid. */
export function floorAreaWithin(point, grid, radius) {
  if (!grid?.cells) return null
  // Outside the building fetch's box there is no data — reporting 0 would put a
  // quarter of the baseline at "zero floor area" and wreck the distribution.
  const c = grid.coverage
  if (c && (point.lng < c.minLng || point.lng > c.maxLng || point.lat < c.minLat || point.lat > c.maxLat)) return null
  const step = grid.grid
  const span = Math.ceil(radius / 100) + 1
  const mx = 111320 * Math.cos(rad(point.lat))
  const cx = Math.round(point.lng / step)
  const cy = Math.round(point.lat / step)
  let total = 0
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      const value = grid.index.get(`${cx + dx},${cy + dy}`)
      if (!value) continue
      if (Math.hypot(dx * step * mx, dy * step * 110540) <= radius) total += value
    }
  }
  return total
}

/** Wrap the shipped grid file into a lookup structure once. */
export function indexFloorGrid(doc) {
  if (!doc?.cells) return null
  const index = new Map()
  for (const [x, y, v] of doc.cells) index.set(`${x},${y}`, v)
  return { grid: doc.grid, index, cells: doc.cells, coverage: doc.coverage || null }
}

const nearest = (point, list) => list.reduce((best, item) => {
  if (item === point || !Number.isFinite(item.lng)) return best
  const d = haversine(point, item)
  return !best || d < best.d ? { d, item } : best
}, null)

/**
 * The scored dimensions.
 *
 * The overall score is the mean of the GROUP scores, not of the metrics. That
 * distinction is the whole point: with a flat average, adding four accessibility
 * metrics would quietly make accessibility count four times as much as footfall.
 * Groups keep the weighting a stated decision instead of a side effect of how
 * many things happened to be measurable.
 */
// Deliberately NOT a metric: 500m 商业用地占比. It computes fine, but OSM's
// landuse=commercial coverage in Chinese cities is patchy, so a 0 means "nobody
// mapped this block" at least as often as "this block is not commercial" — and
// a criterion that scores mapping completeness is worse than no criterion.
export const METRIC_GROUPS = [
  { key: 'demand', label: '客流基础', hint: '这块地上到底有多少人、多少商业活动' },
  { key: 'access', label: '可达性', hint: '人能不能方便地走到门口——不只是地铁' },
  { key: 'pitch', label: '位置质量', hint: '这个铺位本身：临什么街、周围有几条路汇合、街区好不好走' },
]

/** The metrics a pitch is benchmarked on. `lowerBetter` flips the percentile. */
export const BENCH_METRICS = [
  // ── 客流基础 ──
  { key: 'floorArea500', group: 'demand', label: '500m 内建筑面积', unit: '万㎡', scale: 1e4,
    hint: '由真实建筑轮廓×层数算出，代表这块地的人的总量' },
  { key: 'food500', group: 'demand', label: '500m 内餐饮', unit: '家', hint: '商业活跃度' },
  { key: 'mallDist', group: 'demand', label: '最近商场', unit: 'm', lowerBetter: true,
    hint: '购物中心带来的稳定客流' },

  // ── 可达性 ──
  { key: 'metroDist', group: 'access', label: '最近地铁出入口', unit: 'm', lowerBetter: true, hint: '越近越好' },
  { key: 'busStop300', group: 'access', label: '300m 内公交站', unit: '个',
    hint: '地铁只是一半——公交覆盖的客群和地铁往往不重叠' },
  { key: 'crossing150', group: 'access', label: '150m 内过街设施', unit: '处',
    hint: '斑马线/天桥/地道。过不了街，对面的人流就不是你的客流' },
  { key: 'parking300', group: 'access', label: '300m 内停车场', unit: '个', hint: '开车来的客群能不能停下' },

  // ── 位置质量 ──
  { key: 'streetLinks', group: 'pitch', label: '路网交汇度（120m 内道路数）', unit: '条',
    hint: '有几条路在这附近汇合，代表有几个方向的人流能到你门口。是不是真的拐角位要现场确认' },
  { key: 'streetLength500', group: 'pitch', label: '500m 内街道总长', unit: 'km', scale: 1000,
    hint: '街区密度。小街区密路网＝好走＝愿意逛；不含快速路' },
  // ── 不计入总分 ──
  // Label is rewritten per project in rankAgainstReference — a pharmacy chain
  // should not be told how many cafés are nearby.
  { key: 'rivals500', group: null, label: '500m 内同类店', unit: '家',
    hint: '同业竞争，不是越多越好也不是越少越好，所以只提示不计分' },
]

/** Everything measurable about a point. */
export function benchFeatures(point, pois, ctx = {}) {
  const { floorGrid, brandPoints = [], index, basemapIndex, availableKinds } = ctx
  const base = extractFeatures(point, pois, ctx)
  // Which kinds compete depends on what the project is opening, not on cafés.
  const rivalKinds = ctx.rivalKinds || rivalKindsOf(ctx.format)
  const rivals = rivalKinds.flatMap(k => (index
    ? queryRadius(index, point, 500, k)
    : pois.filter(p => p.kind === k && haversine(point, p) <= 500)))
  const nearMall = index ? nearestOfKind(index, point, 'mall') : nearest(point, pois.filter(p => p.kind === 'mall'))
  const nearBrand = nearest(point, brandPoints)
  // A kind the dataset never fetched must come back null, never 0. Zero is a
  // measurement — "we looked, there are no bus stops here" — and reporting it
  // for a layer that was never downloaded is the same thing as making it up.
  // The metric then fails the finite check, drops out of the score, and gets
  // named in `missing` instead of quietly scoring every point identically.
  const count = (kind, radius) => {
    if (availableKinds && !availableKinds.has(kind)) return null
    return index
      ? queryRadius(index, point, radius, kind).length
      : pois.filter(p => p.kind === kind && haversine(point, p) <= radius).length
  }

  const street = streetFeatures(point, basemapIndex)
  const mix = landuseMix(point, basemapIndex, 500)

  const out = {
    ...base,
    ...street,
    floorArea500: floorAreaWithin(point, floorGrid, 500),
    floorArea300: floorAreaWithin(point, floorGrid, 300),
    rivals500: rivals.filter(p => p !== point && haversine(point, p) <= 500).length,
    rivals300: rivals.filter(p => p !== point && haversine(point, p) <= 300).length,
    // Kept under the old names so existing --where expressions and saved
    // projects keep working; both now mean "same category as this project".
    cafe500: rivals.filter(p => p !== point && haversine(point, p) <= 500).length,
    cafe300: rivals.filter(p => p !== point && haversine(point, p) <= 300).length,
    food300: FOOD_KINDS.reduce((a, k) => a + count(k, 300), 0),
    office300: count('office', 300),
    supermarket500: count('supermarket', 500),
    school800: count('school', 800),
    campus1500: count('campus', 1500),
    hospital800: count('hospital', 800),
    metroExit300: count('metro_exit', 300),
    // Accessibility beyond the subway. Absent from the POI set until the
    // transit layer was fetched, which is why "可达性" used to mean "地铁距离".
    busStop300: count('bus', 300),
    busStop500: count('bus', 500),
    parking300: count('parking', 300),
    crossing150: count('crossing', 150),
    // Composition inputs, all on one radius so the shares are comparable.
    residential500: count('residential', 500),
    school500: count('school', 500),
    hotel500: count('hotel', 500),
    commercialShare: mix ? mix.commercial : null,
    residentialShare: mix ? mix.residential : null,
    parkShare: mix ? mix.park : null,
    landuse: landuseAt(point, basemapIndex),
    mallDist: nearMall ? Math.round(nearMall.d) : null,
    mallName: nearMall?.item?.name || '',
    brandDist: nearBrand ? Math.round(nearBrand.d) : null,
    brandName: nearBrand?.item?.name || '',
  }
  out.customerMix = customerMix(out)
  return out
}

function buildMetrics(rows) {
  return BENCH_METRICS.map(spec => {
    const values = rows.map(f => f[spec.key]).filter(Number.isFinite).sort((a, b) => a - b)
    if (values.length < 8) return null
    return { ...spec, n: values.length, values,
      p10: quantile(values, 0.1), p25: quantile(values, 0.25), median: quantile(values, 0.5),
      p75: quantile(values, 0.75), p90: quantile(values, 0.9) }
  }).filter(Boolean)
}

/** Build the reference distribution from where a chosen brand already is. */
export function fitReferenceModel(brandPoints, background, pois, options = {}) {
  const label = options.brandLabel || '参照品牌'
  const n = brandPoints.length
  if (n < 8) {
    return { ready: false, kind: 'reference', sampleSize: n, brandLabel: label,
      reason: `只找到 ${label} 门店 ${n} 家，至少需要 8 家才能建立参照分布` }
  }
  const ctx = { ...options, brandPoints }
  const rows = brandPoints.map(p => benchFeatures(p, pois, ctx))
  const metrics = buildMetrics(rows)

  const spacings = brandPoints.map(p => nearest(p, brandPoints)?.d).filter(Number.isFinite).sort((a, b) => a - b)
  const spacing = spacings.length ? {
    p10: Math.round(quantile(spacings, 0.1)), median: Math.round(quantile(spacings, 0.5)),
    min: Math.round(spacings[0]),
  } : null

  const comparison = background?.length >= 8
    ? fitRevealedModel(brandPoints, background, pois, { ...options, brandLabel: label })
    : null

  const out = [`参照系：${label}在本地已开的 ${n} 家门店。`]
  if (spacing) out.push(`门店最近间距中位数 ${spacing.median} m，10% 分位 ${spacing.p10} m。`)
  const sig = comparison?.features?.filter(f => f.significant) || []
  if (comparison?.ready && !sig.length) {
    out.push(`与本地同类店相比各维度差异均不显著；百分位表示这个点在${label}已选位置中的排名。`)
  } else if (sig.length) {
    out.push(`与本地其他同类店相比，${label}明显偏好：${sig.map(f => f.label).join('、')}。`)
  }

  return { ready: true, kind: 'reference', sampleSize: n, brandLabel: label,
    metrics, spacing, comparison, statements: out, fittedAt: new Date().toISOString() }
}

/**
 * Percentile of `value` within `sorted`, using the midrank for ties.
 * Several of these metrics — crossings, parking, corner position — are zero for
 * half the baseline. Counting only strictly-smaller values puts every one of
 * those points at the 0th percentile, which reads as "worst possible" when it
 * actually means "same as most places". The midrank puts the whole tied block
 * at its true middle instead.
 */
const pctRank = (value, sorted) => {
  if (!sorted.length || !Number.isFinite(value)) return null
  let below = 0, equal = 0
  for (const v of sorted) {
    if (v < value) below += 1
    else if (v === value) equal += 1
    else break
  }
  return Math.round(((below + equal / 2) / sorted.length) * 100)
}

/**
 * Rank one point against a reference distribution.
 * The overall score is just the average of the per-metric percentiles —
 * deliberately transparent, because the user has to be able to disagree with
 * any single line of it.
 */
export function rankAgainstReference(point, pois, model, ctx = {}) {
  const f = benchFeatures(point, pois, { ...ctx, brandPoints: ctx.brandPoints || [] })
  const fmt = formatOf(ctx.format)
  if (!model?.ready) return { features: f, ready: false, metrics: [], groups: [], missing: [],
    score: null, flags: [], exclusions: [], tier: 'unknown', customerMix: f.customerMix,
    field: fieldStatus(point) }

  const metrics = model.metrics.map(m => {
    const value = f[m.key]
    if (!Number.isFinite(value)) return null
    const raw = pctRank(value, m.values)
    const pct = m.lowerBetter ? 100 - raw : raw
    // "500m 内同类店" reads as nothing in particular; name the actual category
    // so a pharmacy project is not left wondering what "同类" means here.
    const label = m.key === 'rivals500' && fmt ? `500m 内${fmt.label}店` : m.label
    return { key: m.key, group: m.group, label, unit: m.unit, scale: m.scale || 1, hint: m.hint,
      value, percentile: pct, median: m.median,
      verdict: pct >= 70 ? 'good' : pct >= 40 ? 'fair' : 'poor' }
  }).filter(Boolean)

  // Competition is judged separately: too many rivals nearby is a real cost, and
  // it should not be averaged away inside a "higher is better" percentile.
  // Everything else scores inside its group, and the groups are then averaged —
  // see METRIC_GROUPS for why the two-level average is not an accident.
  const groups = METRIC_GROUPS.map(g => {
    const rows = metrics.filter(m => m.group === g.key)
    return { ...g, metrics: rows, n: rows.length,
      score: rows.length ? Math.round(mean(rows.map(m => m.percentile))) : null }
  })
  const ready = groups.filter(g => g.score !== null)
  const score = ready.length ? Math.round(mean(ready.map(g => g.score))) : null

  // Which criteria could not be answered at all. Naming them is the point: the
  // alternative is a score that quietly means less than it looks like it means.
  const missing = BENCH_METRICS
    .filter(spec => spec.group && !metrics.some(m => m.key === spec.key))
    .map(spec => ({ key: spec.key, label: spec.label, hint: spec.hint }))

  // Physical prerequisites no amount of footfall compensates for.
  const exclusions = []
  for (const rule of HARD_RULES) {
    if (point[rule.key] === false) exclusions.push({ key: rule.key, text: rule.fail })
  }

  const flags = []
  if (model.spacing && Number.isFinite(f.brandDist) && f.brandDist < model.spacing.p10) {
    flags.push({ level: 'bad', key: 'cannibalization',
      text: `最近${model.brandLabel}门店仅 ${f.brandDist} m${f.brandName ? `（${f.brandName}）` : ''}，近于 90% 的现有间距，有自我蚕食风险。` })
  }
  const cafeMetric = metrics.find(m => m.key === 'rivals500')
  if (cafeMetric && cafeMetric.value > cafeMetric.median * 1.8) {
    flags.push({ level: 'warn', key: 'competition',
      text: `500m 内已有 ${cafeMetric.value} 家${fmt ? fmt.label : '同类'}店，是基线中位（${Math.round(cafeMetric.median)} 家）的 ${(cafeMetric.value / Math.max(cafeMetric.median, 1)).toFixed(1)} 倍。` })
  }
  if (Number.isFinite(f.metroDist) && f.metroDist > 900) {
    const bus = Number.isFinite(f.busStop300) ? f.busStop300 : null
    flags.push({ level: bus ? 'warn' : 'bad', key: 'metro',
      text: `最近地铁出入口 ${f.metroDist} m，步行超过 10 分钟`
        + (bus === null ? '。' : bus > 0 ? `，300m 内有 ${bus} 个公交站。` : '，300m 内也没有公交站。') })
  }
  // A grade-separated road next to the door does not add traffic, it takes it
  // away: nobody crosses six lanes for a coffee, so half the nominal catchment
  // is not actually reachable on foot.
  if (Number.isFinite(f.severingDist) && f.severingDist < 120) {
    flags.push({ level: 'warn', key: 'severance',
      // Name the severing road, not the one the shop fronts — those are usually
      // different roads, and printing the wrong one made the warning nonsense.
      text: `${f.severingName ? `${f.severingName}（快速路/城市干道）` : '一条快速路/城市干道'}`
        + `在 ${f.severingDist} m 外，对面客流过不来。` })
  }
  if (Number.isFinite(f.crossing150) && f.crossing150 === 0 && ROAD_CLASS[f.roadClass]?.arterial) {
    flags.push({ level: 'warn', key: 'crossing',
      text: `临${ROAD_CLASS[f.roadClass].label}但 150m 内无过街设施。` })
  }
  if (Number.isFinite(f.streetLinks) && f.streetLinks <= 1 && Number.isFinite(f.roadDist) && f.roadDist > 60) {
    flags.push({ level: 'warn', key: 'visibility',
      text: `不在路口，离最近道路 ${f.roadDist} m，内街/退线位置。` })
  }
  const faSpec = model.metrics.find(m => m.key === 'floorArea500')
  if (faSpec && Number.isFinite(f.floorArea500) && f.floorArea500 < faSpec.p10) {
    flags.push({ level: 'bad', key: 'density', text: '周边建筑面积低于基线 10% 分位。' })
  }

  const tier = exclusions.length ? 'no'
    : score === null ? 'unknown'
    : flags.some(x => x.level === 'bad') ? 'no'
    : score >= 65 ? 'visit' : score >= 40 ? 'maybe' : 'no'

  return { ready: true, features: f, metrics, groups, missing, score, flags, exclusions, tier,
    customerMix: f.customerMix, field: fieldStatus(point) }
}

// ══════════════════════════════════════════════════════════
//  Street geometry and land use: the pitch itself
//
//  Everything above answers "what is around this point". None of it answers
//  "what is this point" — which street it fronts, whether it sits on a corner,
//  whether a grade-separated road cuts it off from half its catchment. Those
//  come from the basemap, not the POI set, so they need their own index.
// ══════════════════════════════════════════════════════════

export const ROAD_CLASS = {
  // In this basemap `expy` covers motorway AND trunk, so it holds both 延安高架路
  // and 东长安街. Both sever pedestrian flow — fences, long crossing cycles —
  // but the label must not promise every one of them is elevated.
  expy:  { label: '快速路/城市干道', rank: 5, arterial: true, severing: true },
  major: { label: '主干道', rank: 4, arterial: true },
  minor: { label: '次干道', rank: 3, arterial: true },
  // A *_link is usually just a turning lane at a junction, not a barrier, so it
  // neither severs a catchment nor counts as the street a shop fronts.
  link:  { label: '匝道/联络线', rank: 2, slip: true },
  local: { label: '支路 / 街巷', rank: 1 },
}

const SEG_CELL = 0.004   // ≈ 340 m of longitude at these latitudes
// 120 m, not 40. The basemap is arterials plus some locals — the median shop
// sits 39 m from the nearest mapped centreline and half the alleys are not in
// it at all — so a 40 m test scored OSM's road coverage, not the pitch. At
// 120 m the measure is honest about what it is: how many distinct roads
// converge near this spot, which is an approach-direction and visibility proxy.
// Whether the unit is literally on the corner is a site visit's job.
const JUNCTION_R = 120
// How far out to bother looking for an arterial or a severing road. Without an
// explicit bound these distances were whatever the grid happened to sweep,
// which made "no expressway nearby" and "expressway 700 m away" indistinguishable.
const NEARBY_ROAD_R = 250
const M_PER_DEG_LAT = 111320
const mPerDegLng = lat => 111320 * Math.cos(rad(lat))

/** Metres from p to segment a–b, in a local flat projection (fine under ~2 km). */
function distToSegment(p, a, b) {
  const kx = mPerDegLng(p.lat), ky = M_PER_DEG_LAT
  const px = (p.lng - a[0]) * kx, py = (p.lat - a[1]) * ky
  const vx = (b[0] - a[0]) * kx, vy = (b[1] - a[1]) * ky
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return Math.hypot(px, py)
  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2))
  return Math.hypot(px - t * vx, py - t * vy)
}

/**
 * Length of the part of segment a–b that lies inside a circle of radius R.
 *
 * Summing whole segments that merely reach into the circle is not the same
 * measurement: OSM stores long arterials as very few points, so a single 2 km
 * way clipping the edge of a 500 m catchment would contribute all 2 km to what
 * is supposed to be "street inside 500 m".
 */
function segLengthWithin(p, a, b, R) {
  const kx = mPerDegLng(p.lat), ky = M_PER_DEG_LAT
  const ax = (a[0] - p.lng) * kx, ay = (a[1] - p.lat) * ky
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky
  const qa = dx * dx + dy * dy
  if (qa === 0) return 0
  const qb = 2 * (ax * dx + ay * dy)
  const qc = ax * ax + ay * ay - R * R
  const disc = qb * qb - 4 * qa * qc
  if (disc <= 0) return 0                       // the whole line misses the circle
  const root = Math.sqrt(disc)
  const lo = Math.max(0, (-qb - root) / (2 * qa))
  const hi = Math.min(1, (-qb + root) / (2 * qa))
  return hi > lo ? (hi - lo) * Math.sqrt(qa) : 0
}

function cellsFor(minLng, minLat, maxLng, maxLat) {
  const out = []
  for (let x = Math.floor(minLng / SEG_CELL); x <= Math.floor(maxLng / SEG_CELL); x += 1) {
    for (let y = Math.floor(minLat / SEG_CELL); y <= Math.floor(maxLat / SEG_CELL); y += 1) out.push(`${x},${y}`)
  }
  return out
}

/**
 * Grid index over road segments and land-use polygons.
 * Built once per dataset: the district baseline evaluates thousands of points,
 * and a linear scan of ~40k segments per point is not survivable in a browser.
 */
export function indexBasemap(basemap) {
  if (!basemap) return null
  const segCells = new Map()
  const roads = basemap.roads || []
  for (let ri = 0; ri < roads.length; ri += 1) {
    const road = roads[ri]
    const pts = road.p || []
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i], b = pts[i + 1]
      const seg = { a, b, c: road.c, n: road.n || '', ri }
      for (const key of cellsFor(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]))) {
        let bucket = segCells.get(key)
        if (!bucket) { bucket = []; segCells.set(key, bucket) }
        bucket.push(seg)
      }
    }
  }

  const areaCells = new Map()
  for (const area of basemap.areas || []) {
    const ring = area.p || []
    if (ring.length < 3) continue
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
    const item = { c: area.c, ring, box: [minLng, minLat, maxLng, maxLat] }
    for (const key of cellsFor(minLng, minLat, maxLng, maxLat)) {
      let bucket = areaCells.get(key)
      if (!bucket) { bucket = []; areaCells.set(key, bucket) }
      bucket.push(item)
    }
  }
  return { segCells, areaCells, roadCount: roads.length, areaCount: (basemap.areas || []).length }
}

function nearCells(map, point, radius) {
  const span = Math.ceil(radius / (SEG_CELL * mPerDegLng(point.lat))) + 1
  const cx = Math.floor(point.lng / SEG_CELL), cy = Math.floor(point.lat / SEG_CELL)
  const out = []
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      const bucket = map.get(`${cx + dx},${cy + dy}`)
      if (bucket) out.push(bucket)
    }
  }
  return out
}

/** Ray casting; ring is a closed or open list of [lng, lat]. */
function inRing(point, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > point.lat) !== (yj > point.lat)
      && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function landuseAt(point, basemapIndex) {
  if (!basemapIndex) return null
  for (const bucket of nearCells(basemapIndex.areaCells, point, 1)) {
    for (const area of bucket) {
      const [minLng, minLat, maxLng, maxLat] = area.box
      if (point.lng < minLng || point.lng > maxLng || point.lat < minLat || point.lat > maxLat) continue
      if (inRing(point, area.ring)) return area.c
    }
  }
  return null
}

/** Ring-sampled land-use mix: exact polygon clipping buys nothing here. */
function landuseMix(point, basemapIndex, radius = 500) {
  if (!basemapIndex) return null
  const samples = [point]
  for (const [r, n] of [[radius * 0.5, 8], [radius, 12]]) {
    for (let i = 0; i < n; i += 1) {
      const th = (2 * Math.PI * i) / n
      samples.push({
        lng: point.lng + (r * Math.cos(th)) / mPerDegLng(point.lat),
        lat: point.lat + (r * Math.sin(th)) / M_PER_DEG_LAT,
      })
    }
  }
  const tally = {}
  for (const s of samples) {
    const c = landuseAt(s, basemapIndex) || 'none'
    tally[c] = (tally[c] || 0) + 1
  }
  const share = c => Math.round(((tally[c] || 0) / samples.length) * 100)
  return { commercial: share('commercial'), residential: share('residential'),
    park: share('park') + share('green'), industrial: share('industrial'), water: share('water') }
}

/**
 * What street is this, and what kind of pitch does it make?
 * `streetLinks` is the corner test: two or more differently-named streets
 * meeting within 45 m is a corner unit, which sees two approach flows instead
 * of one. `severingDist` is the opposite — an expressway or ramp close enough
 * to cut the catchment, because nobody crosses six lanes for a coffee.
 */
export function streetFeatures(point, basemapIndex, junctionRadius = JUNCTION_R) {
  const empty = { roadDist: null, roadClass: null, roadClassLabel: '', roadName: '',
    streetLinks: null, streetLength500: null, arterialDist: null,
    severingDist: null, severingName: '' }
  if (!basemapIndex) return empty

  let best = null
  let bestAny = null
  let bestArterial = null
  let bestSevering = null
  // Counts distinct WAYS, not distinct names: counting names measured OSM's
  // naming completeness instead of the junction — 61% of the Shanghai baseline
  // had no *named* road within 45 m, which is a mapping artefact, not 61% of
  // shops sitting mid-block.
  const ways = new Set()

  for (const bucket of nearCells(basemapIndex.segCells, point, Math.max(NEARBY_ROAD_R, junctionRadius))) {
    for (const seg of bucket) {
      const d = distToSegment(point, seg.a, seg.b)
      const meta = ROAD_CLASS[seg.c]
      if (!bestAny || d < bestAny.d) bestAny = { d, seg }
      if (!meta?.slip && (!best || d < best.d)) best = { d, seg }
      if (d <= NEARBY_ROAD_R) {
        if (meta?.arterial && (!bestArterial || d < bestArterial.d)) bestArterial = { d, seg }
        if (meta?.severing && (!bestSevering || d < bestSevering.d)) bestSevering = { d, seg }
      }
      if (d <= junctionRadius) ways.add(seg.ri)
    }
  }

  // A segment is indexed into every cell its bounding box touches, so one that
  // spans a cell boundary shows up in several buckets. Min-distance and the way
  // Set do not care, but a running total does — without this the reported street
  // kilometres are inflated by however many cells each segment happens to cross.
  let length = 0
  const counted = new Set()
  for (const bucket of nearCells(basemapIndex.segCells, point, 500)) {
    for (const seg of bucket) {
      // Expressway lane-kilometres are not walkable street, so they must not
      // read as a fine-grained, strollable block structure.
      if (seg.c === 'expy' || seg.c === 'link') continue
      if (counted.has(seg)) continue
      counted.add(seg)
      length += segLengthWithin(point, seg.a, seg.b, 500)
    }
  }

  const front = best || bestAny
  const meta = front ? ROAD_CLASS[front.seg.c] : null
  return {
    roadDist: front ? Math.round(front.d) : null,
    roadClass: front?.seg.c || null,
    roadClassLabel: meta?.label || '',
    roadName: front?.seg.n || '',
    streetLinks: ways.size,
    streetLength500: Math.round(length),
    // null means "none within NEARBY_ROAD_R", not "unknown".
    arterialDist: bestArterial ? Math.round(bestArterial.d) : null,
    severingDist: bestSevering ? Math.round(bestSevering.d) : null,
    severingName: bestSevering?.seg.n || '',
  }
}

/**
 * Who is around, as a mix rather than a pile of counts.
 * Deliberately NOT scored: a 90% office catchment is excellent for a lunch
 * canteen and fatal for a weekend brunch room, so there is no "good" direction
 * to rank it in. It is shown, and matched against a reference brand's own mix
 * when the project names one.
 */
export const CUSTOMER_SEGMENTS = [
  { key: 'worker', label: '上班族', hint: '工作日白天，午市和下午茶' },
  { key: 'resident', label: '居民', hint: '晚间和周末，复购靠他们' },
  { key: 'student', label: '学生', hint: '价格敏感，寒暑假断档' },
  { key: 'visitor', label: '外来客流', hint: '商场、酒店、医院带来的过路客，回头率低' },
]

export function customerMix(f) {
  const raw = {
    worker: f.office500 ?? 0,
    resident: f.residential500 ?? 0,
    student: (f.school500 ?? 0) + (f.campus1500 ?? 0),
    visitor: (f.mall300 ?? 0) * 3 + (f.hotel500 ?? 0) + (f.hospital800 ?? 0),
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0)
  if (!total) return null
  const shares = {}
  for (const seg of CUSTOMER_SEGMENTS) shares[seg.key] = Math.round((raw[seg.key] / total) * 100)
  const top = CUSTOMER_SEGMENTS.map(s => ({ ...s, share: shares[s.key] })).sort((a, b) => b.share - a.share)
  return { raw, shares, total, dominant: top[0], top,
    dayNight: raw.worker + raw.resident > 0
      ? Math.round((raw.worker / (raw.worker + raw.resident)) * 100) : null }
}

// ══════════════════════════════════════════════════════════
//  Spatial index
//
//  Every feature lookup used to scan all ~11k POIs six times over. Fine for one
//  click, hopeless for building a district-wide distribution from thousands of
//  sample points, so radius queries go through a grid.
// ══════════════════════════════════════════════════════════

const CELL = 0.005   // ≈ 430 m of longitude at this latitude

export function indexPois(pois) {
  const cells = new Map()
  for (const p of pois) {
    if (!Number.isFinite(p.lng)) continue
    const key = `${Math.round(p.lng / CELL)},${Math.round(p.lat / CELL)}`
    let bucket = cells.get(key)
    if (!bucket) { bucket = []; cells.set(key, bucket) }
    bucket.push(p)
  }
  return { cells, all: pois }
}

export function queryRadius(index, point, radius, kind) {
  if (!index) return null
  const span = Math.ceil(radius / (CELL * 85000)) + 1
  const cx = Math.round(point.lng / CELL), cy = Math.round(point.lat / CELL)
  const out = []
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      const bucket = index.cells.get(`${cx + dx},${cy + dy}`)
      if (!bucket) continue
      for (const p of bucket) {
        if (kind && p.kind !== kind) continue
        if (haversine(point, p) <= radius) out.push(p)
      }
    }
  }
  return out
}

/**
 * Grid index over any list of {lng, lat} records — listings, footfall cells,
 * malls. Same cell size as the POI index so the radius maths is shared.
 */
export function indexMarket(rows) {
  return indexPois((rows || []).map(r => ({ ...r, kind: '__market__' })))
}

/** Nearest POI of a kind, growing the search radius until something turns up. */
export function nearestOfKind(index, point, kind, maxRadius = 6000) {
  for (let r = 400; r <= maxRadius; r *= 2) {
    const hits = queryRadius(index, point, r, kind)
    if (hits?.length) {
      return hits.reduce((best, p) => {
        const d = haversine(point, p)
        return !best || d < best.d ? { d, item: p } : best
      }, null)
    }
  }
  return null
}

/**
 * Business formats the workbench can site.
 *
 * The model used to assume a café: competition was always "how many cafés
 * within 500 m", and the reference-brand comparison only ever looked at cafés.
 * That is fine for one demo and useless for a pharmacy chain. A format now
 * declares which POI kinds count as its OWN competition; everything else about
 * scoring is format-independent.
 *
 * `kinds` is also what a reference brand is searched within — asking for 屈臣氏
 * should look at chemists, not at every shop in the city.
 */
export const FORMATS = [
  { id: 'cafe', label: '咖啡', kinds: ['cafe'] },
  { id: 'teadrink', label: '茶饮', kinds: ['teadrink'] },
  { id: 'restaurant', label: '正餐', kinds: ['restaurant'] },
  { id: 'fastfood', label: '快餐 / 小吃', kinds: ['fastfood'] },
  { id: 'bakery', label: '烘焙 / 甜品', kinds: ['bakery', 'dessert'] },
  { id: 'bar', label: '酒吧 / 夜宵', kinds: ['bar'] },
  { id: 'convenience', label: '便利店', kinds: ['convenience'] },
  { id: 'supermarket', label: '超市 / 生鲜', kinds: ['supermarket'] },
  { id: 'clothes', label: '服装 / 鞋包', kinds: ['clothes'] },
  { id: 'cosmetics', label: '美妆 / 个护', kinds: ['cosmetics'] },
  { id: 'jewelry', label: '珠宝 / 钟表', kinds: ['jewelry'] },
  { id: 'optician', label: '眼镜', kinds: ['optician'] },
  { id: 'electronics', label: '数码 / 手机', kinds: ['electronics'] },
  { id: 'books', label: '书店 / 文具', kinds: ['books'] },
  { id: 'homeware', label: '家居 / 建材', kinds: ['homeware'] },
  { id: 'sports', label: '运动 / 户外', kinds: ['sports'] },
  { id: 'toys', label: '玩具 / 母婴', kinds: ['toys'] },
  { id: 'pet', label: '宠物', kinds: ['pet'] },
  { id: 'pharmacy', label: '药店', kinds: ['pharmacy'] },
  { id: 'hairdresser', label: '美发 / 美甲 / 按摩', kinds: ['hairdresser'] },
  { id: 'gym', label: '健身', kinds: ['gym'] },
  { id: 'education', label: '教培', kinds: ['education'] },
  { id: 'laundry', label: '洗衣 / 裁缝', kinds: ['laundry'] },
  { id: 'repair', label: '维修', kinds: ['repair'] },
  { id: 'florist', label: '鲜花 / 园艺', kinds: ['florist'] },
]

/**
 * Tea-drink chains, recognised by name.
 *
 * `shop=bubble_tea` is essentially unused in China: 蜜雪冰城, 喜茶, CoCo, 霸王茶姬
 * and 奈雪的茶 are all tagged `amenity=cafe`, so classifying by tag alone gave
 * 茶饮 zero locations in Beijing while quietly filing 134 tea shops as cafés.
 * The names are already in the data — this reads them, it does not invent them.
 */
const TEA_BRANDS = ['蜜雪冰城', '喜茶', '奈雪', '茶百道', '古茗', '霸王茶姬', '沪上阿姨',
  'CoCo', '都可', '一点点', '茶颜悦色', '书亦', '益禾堂', '甜啦啦', '茶话弄', '快乐柠檬',
  '贡茶', 'coco都可', '乐乐茶', '7分甜', '悸动', '阿水大杯茶', '茶集', '去茶山']
const TEA_WORDS = /(奶茶|茶饮|果茶|鲜茶|茗茶|柠檬茶)/

/**
 * Reclassify POIs whose tags are less accurate than their names.
 * Applied once per dataset at load, so both shipped and freshly fetched data
 * get the same treatment without a re-fetch.
 */
export function refineKinds(pois) {
  let moved = 0
  for (const p of pois) {
    if (p.kind !== 'cafe' && p.kind !== 'fastfood') continue
    const name = p.name
    if (!name) continue
    if (TEA_BRANDS.some(b => name.includes(b)) || TEA_WORDS.test(name)) {
      p.kind = 'teadrink'
      moved += 1
    }
  }
  return moved
}

/** Everything that is a shop of some sort — the ambient commercial baseline. */
export const RETAIL_KINDS = [...new Set(FORMATS.flatMap(f => f.kinds))]

/**
 * F&B, kept as a group because several features count "餐饮" as a whole.
 *
 * `food` is the pre-split kind: datasets fetched before the category expansion
 * lump every restaurant under it. Keeping it here means an existing project
 * keeps scoring correctly instead of silently reporting a tenth of the
 * restaurants it did yesterday — the split must not invalidate saved work.
 */
export const LEGACY_FOOD_KIND = 'food'
export const FOOD_KINDS = ['restaurant', 'fastfood', 'cafe', 'teadrink', 'bakery', 'bar', 'dessert',
  LEGACY_FOOD_KIND]

/**
 * Resolve a format from an id, a label, or one of the free-text values older
 * projects stored before formats existed. Matching on all three means a project
 * created last week keeps scoring the same way it did.
 */
const FORMAT_ALIASES = {
  咖啡: 'cafe', 咖啡店: 'cafe', 茶饮: 'teadrink', 奶茶: 'teadrink',
  餐饮: 'restaurant', 连锁餐饮: 'restaurant', 正餐: 'restaurant',
  快餐: 'fastfood', 小吃: 'fastfood', 烘焙: 'bakery', 甜品: 'bakery',
  便利店: 'convenience', 超市: 'supermarket', 服装: 'clothes',
  美妆: 'cosmetics', 药店: 'pharmacy', 健身: 'gym', 书店: 'books',
}
export const formatOf = value => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const id = FORMAT_ALIASES[raw] || raw
  return FORMATS.find(f => f.id === id || f.label === raw) || null
}
/** Which kinds compete with this project. Unknown format → the whole F&B group. */
/**
 * Which kinds compete with this format.
 *
 * Formats whose own kind did not exist before the split also match the legacy
 * `food` bucket, so "how many rivals nearby" stays answerable on an old
 * dataset. Formats that always had their own kind (cafe, supermarket, mall)
 * must NOT widen to it, or a café would count every restaurant as a rival.
 */
const LEGACY_FOOD_FORMATS = new Set(['restaurant', 'fastfood', 'teadrink', 'bakery', 'bar'])
export const rivalKindsOf = id => {
  const fmt = formatOf(id)
  if (!fmt) return FOOD_KINDS
  return LEGACY_FOOD_FORMATS.has(fmt.id) ? [...fmt.kinds, LEGACY_FOOD_KIND] : fmt.kinds
}

/**
 * The ambient commercial baseline: every location in the district that already
 * hosts a shop. Ranking against it answers "is this a good pitch here?" without
 * requiring the user to nominate a brand to imitate.
 */
export const BASELINE_KINDS = [...new Set([...RETAIL_KINDS, 'mall', LEGACY_FOOD_KIND])]

/**
 * Below this many same-format locations the percentiles are noise, and ranking
 * against them says more about the sample than about the pitch.
 */
export const FORMAT_BASELINE_MIN = 80

/**
 * Rank against locations of the SAME format when the city has enough of them.
 *
 * Ranking every business against "all commercial locations" gives a hardware
 * store and a coffee chain the same score for the same address, because none of
 * the scored metrics depend on what you are opening. Hardware stores and coffee
 * shops have, however, already chosen very different addresses — so the honest
 * format-specific baseline is where that format actually is, not a set of
 * weights somebody invented.
 *
 * Where a city has too few of a format to fit a distribution, it falls back to
 * the all-retail baseline and says so, rather than pretending.
 */
export function fitDistrictModel(pois, options = {}) {
  const index = options.index || indexPois(pois)
  const fmt = formatOf(options.format)
  const realOwn = fmt ? pois.filter(p => fmt.kinds.includes(p.kind)) : []
  // Formats OSM barely covers get their real locations resampled up to a usable
  // sample — see scripts/thicken-formats.mjs. Tracked separately so the model
  // can always say how much of its baseline was measured.
  const synthetic = fmt
    ? (options.syntheticStores || []).filter(x => x.format === fmt.id)
    : []
  const own = [...realOwn, ...synthetic]
  const useOwn = own.length >= FORMAT_BASELINE_MIN
  const sample = useOwn ? own : pois.filter(p => BASELINE_KINDS.includes(p.kind))
  const basis = useOwn ? 'format' : 'retail'
  if (sample.length < 50) {
    return { ready: false, kind: 'district', sampleSize: sample.length,
      reason: `本地只有 ${sample.length} 个商业位置，不足以建立基线` }
  }
  const ctx = { ...options, index }
  const rows = sample.map(p => benchFeatures(p, pois, ctx))
  const metrics = BENCH_METRICS.map(spec => {
    const values = rows.map(f => f[spec.key]).filter(Number.isFinite).sort((a, b) => a - b)
    if (values.length < 50) return null
    return { ...spec, n: values.length, values,
      p10: quantile(values, 0.1), p25: quantile(values, 0.25), median: quantile(values, 0.5),
      p75: quantile(values, 0.75), p90: quantile(values, 0.9) }
  }).filter(Boolean)

  const where = options.districtLabel || '本区'
  const synCount = useOwn ? synthetic.length : 0
  return {
    ready: true, kind: 'district', basis, sampleSize: sample.length,
    formatLabel: fmt?.label || '',
    ownCount: own.length,
    realCount: useOwn ? realOwn.length : sample.length,
    syntheticCount: synCount,
    brandLabel: useOwn ? `${where}的${fmt.label}店` : (options.districtLabel || '本区商业位置'),
    metrics, spacing: null,
    statements: useOwn ? [
      synCount
        ? `基线：${where} ${realOwn.length} 家真实${fmt.label}店，加 ${synCount} 家按选址特征扩样，共 ${sample.length} 家。`
        : `基线：${where} ${sample.length} 家已开的${fmt.label}店。`,
    ] : [
      `基线：${where} ${sample.length} 个已有商业经营的位置。`,
      ...(fmt ? [`⚠ ${where}只有 ${own.length} 家${fmt.label}店，不足 ${FORMAT_BASELINE_MIN} 家，改用全零售基线。`] : []),
    ],
    fittedAt: new Date().toISOString(),
  }
}

/**
 * Scan the district for locations that score at or above a threshold.
 *
 * Candidates are the addressable commercial locations already in the data —
 * real places with names, not arbitrary grid points, so every hit is somewhere
 * a person can actually go and look at. Results are spatially de-duplicated:
 * twenty hits on one block is not twenty options.
 */
export function findHighScoring(pois, model, options = {}) {
  const { minScore = 80, limit = 30, spacing = 250, kinds = BASELINE_KINDS, onlyNamed = false,
    where = null, near = null, radius = null } = options
  if (!model?.ready) return { ready: false, reason: '还没有可用的评分基线', hits: [] }

  let candidates = pois.filter(p => kinds.includes(p.kind) && (!onlyNamed || p.name))
  if (near && radius) candidates = candidates.filter(p => haversine(near, p) <= radius)

  const scored = []
  for (const p of candidates) {
    const r = rankAgainstReference(p, pois, model, options)
    if (r.score === null || r.score < minScore) continue
    const pct = Object.fromEntries((r.metrics || []).map(m => [m.key, m.percentile]))
    // `where` is an arbitrary predicate over the feature vocabulary, so the
    // caller can express "地铁 200m 内 且 500m 餐饮 > 30 且 在商场商圈" without
    // this function needing to know about any of those concepts.
    const grp = Object.fromEntries((r.groups || []).map(g => [g.key, g.score]))
    if (where && !where(r.features, pct, r.score, p, grp)) continue
    scored.push({
      lng: p.lng, lat: p.lat, name: p.name || '', kind: p.kind, cat: p.cat || '',
      score: r.score, tier: r.tier, metrics: r.metrics, groups: r.groups, flags: r.flags,
      features: r.features, pct, grp,
    })
  }
  scored.sort((a, b) => b.score - a.score)

  // Greedy spatial thinning so the list spans the district instead of one street.
  const hits = []
  for (const row of scored) {
    if (hits.some(h => haversine(h, row) < spacing)) continue
    hits.push(row)
    if (hits.length >= limit) break
  }
  return { ready: true, scanned: candidates.length, matched: scored.length, hits, minScore, spacing }
}
