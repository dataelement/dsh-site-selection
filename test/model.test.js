import test from 'node:test'
import assert from 'node:assert/strict'
import {
  haversine, extractFeatures, districtType, criticalR,
  fitDistrictModel, rankAgainstReference, indexPois, walkRadius,
} from '../src/model.js'

// A tiny synthetic town: one metro, food clustered west, offices east, homes west.
const P = (kind, lng, lat, extra = {}) => ({ id: `${kind}-${lng}-${lat}`, kind, name: '', lng, lat, ...extra })
const around = (lng, lat, kind, n, spread = 0.003) =>
  Array.from({ length: n }, (_, i) => P(kind, lng + ((i % 5) - 2) * spread * 0.2, lat + (Math.floor(i / 5) - 2) * spread * 0.2))

const POIS = [
  P('metro', 121.450, 31.225),
  ...around(121.440, 31.225, 'restaurant', 40),
  ...around(121.440, 31.225, 'residential', 30),
  ...around(121.462, 31.225, 'restaurant', 20),
  ...around(121.462, 31.225, 'office', 30),
  P('mall', 121.470, 31.230),
]

test('haversine matches a known distance', () => {
  // 0.01° of latitude ≈ 1105 m
  const d = haversine({ lng: 121.45, lat: 31.22 }, { lng: 121.45, lat: 31.23 })
  assert.ok(Math.abs(d - 1105) < 15, `got ${d}`)
})

test('walkRadius applies a street-network factor', () => {
  assert.equal(walkRadius(5), 300)
  assert.equal(walkRadius(15), 900)
})

test('districtType reads the mix around the point, not a label', () => {
  assert.equal(districtType({ mall300: 1, office500: 0, residential800: 40 }), '商场')
  assert.equal(districtType({ mall300: 0, office500: 30, residential800: 2 }), '写字楼')
  assert.equal(districtType({ mall300: 0, office500: 1, residential800: 30 }), '社区')
  assert.equal(districtType({ mall300: 0, office500: 10, residential800: 12 }), '混合街铺')
})

test('extractFeatures counts only what is inside each radius', () => {
  const west = extractFeatures({ lng: 121.440, lat: 31.225 }, POIS, {})
  const east = extractFeatures({ lng: 121.462, lat: 31.225 }, POIS, {})
  assert.equal(west.districtType, '社区')
  assert.equal(east.districtType, '写字楼')
  assert.ok(west.food500 > east.food500)
  assert.ok(west.residential800 > 0 && east.residential800 === 0)
  assert.ok(west.metroDist > 500 && west.metroDist < 1500)
})

test('rivals are matched by brand name, and only among food POIs', () => {
  const pois = [P('restaurant', 121.45, 31.225, { name: '老乡鸡 静安店' }), P('restaurant', 121.4501, 31.225, { name: '某咖啡' }),
    P('office', 121.4502, 31.225, { name: '老乡鸡集团总部' })]
  const f = extractFeatures({ lng: 121.45, lat: 31.225 }, pois, { rivals: { brands: ['老乡鸡'] } })
  assert.equal(f.food500, 2)
  assert.equal(f.rival500, 1, '办公楼里的同名公司不是竞品')
})

test('criticalR reproduces the standard p<0.05 table', () => {
  const table = [[10, 0.632], [15, 0.514], [20, 0.444], [30, 0.361]]
  for (const [n, expected] of table) {
    assert.ok(Math.abs(criticalR(n) - expected) < 0.01, `n=${n}: ${criticalR(n)} vs ${expected}`)
  }
})


// ── the reworked criteria ────────────────────────────────

import {
  indexBasemap, streetFeatures, landuseAt, customerMix, fieldStatus, benchFeatures,
  nearestOfKind, METRIC_GROUPS, BENCH_METRICS, FIELD_CHECKS, ROAD_CLASS,
  FORMATS, RETAIL_KINDS, rivalKindsOf, BASELINE_KINDS,
} from '../src/model.js'

// A cross: one east–west arterial and one north–south local street meeting at
// 121.450/31.225, plus a motorway slip lane hugging the arterial.
const BASEMAP = {
  roads: [
    { c: 'major', n: '大马路', p: [[121.440, 31.225], [121.460, 31.225]] },
    { c: 'local', n: '小街', p: [[121.450, 31.215], [121.450, 31.235]] },
    { c: 'link', n: '', p: [[121.4400, 31.2252], [121.4600, 31.2252]] },
    { c: 'expy', n: '高架', p: [[121.470, 31.215], [121.470, 31.235]] },
  ],
  areas: [
    { c: 'commercial', p: [[121.448, 31.223], [121.452, 31.223], [121.452, 31.227], [121.448, 31.227]] },
  ],
}

test('streetFeatures reads the street a pitch fronts, not the slip lane beside it', () => {
  const idx = indexBasemap(BASEMAP)
  // 200 m east of the junction: 大马路 is underfoot, the slip lane is 22 m north,
  // 小街 is 190 m west. A turning lane is not the street an address fronts.
  const f = streetFeatures({ lng: 121.4520, lat: 31.2250 }, idx)
  assert.equal(f.roadName, '大马路')
  assert.equal(f.roadClass, 'major')
  assert.ok(f.roadDist < 10, `roadDist ${f.roadDist}`)
})

test('a slip lane does not sever a catchment, an expressway does', () => {
  const idx = indexBasemap(BASEMAP)
  assert.equal(ROAD_CLASS.link.severing, undefined)
  assert.equal(ROAD_CLASS.expy.severing, true)
  // 2 km from the expressway: null means "none within 250 m", not "unknown".
  const beside = streetFeatures({ lng: 121.450, lat: 31.2250 }, idx)
  assert.equal(beside.severingDist, null)
  const onExpy = streetFeatures({ lng: 121.4699, lat: 31.2250 }, idx)
  assert.ok(onExpy.severingDist < 50, `got ${onExpy.severingDist}`)
})

test('streetLinks counts distinct ways, so one road is not a junction', () => {
  const idx = indexBasemap(BASEMAP)
  const junction = streetFeatures({ lng: 121.450, lat: 31.2250 }, idx)
  assert.ok(junction.streetLinks >= 3, `at the cross: ${junction.streetLinks}`)
  assert.equal(junction.roadDist, 0)
  // 800 m west along the arterial: the local street is far outside 120 m.
  const midBlock = streetFeatures({ lng: 121.4415, lat: 31.2250 }, idx)
  assert.ok(midBlock.streetLinks < junction.streetLinks,
    `mid-block ${midBlock.streetLinks} should be under junction ${junction.streetLinks}`)
})

test('streetLength500 ignores expressway kilometres', () => {
  const idx = indexBasemap(BASEMAP)
  const f = streetFeatures({ lng: 121.4699, lat: 31.2250 }, idx)
  // Standing on the expressway, the only walkable street within 500 m is none
  // of it — the expy and its link must not read as a strollable block.
  assert.ok(f.streetLength500 < 200, `got ${f.streetLength500} m`)
})

test('landuseAt is a point-in-polygon test, not a nearest-polygon guess', () => {
  const idx = indexBasemap(BASEMAP)
  assert.equal(landuseAt({ lng: 121.450, lat: 31.225 }, idx), 'commercial')
  assert.equal(landuseAt({ lng: 121.460, lat: 31.225 }, idx), null)
})

test('customerMix reports shares, and refuses to invent one from nothing', () => {
  assert.equal(customerMix({ office500: 0, residential500: 0, school500: 0, campus1500: 0,
    mall300: 0, hotel500: 0, hospital800: 0 }), null)
  const mix = customerMix({ office500: 90, residential500: 10, school500: 0, campus1500: 0,
    mall300: 0, hotel500: 0, hospital800: 0 })
  assert.equal(mix.dominant.key, 'worker')
  assert.equal(mix.shares.worker, 90)
  assert.equal(mix.dayNight, 90)
})

test('fieldStatus separates answered from unanswered, and null is unanswered', () => {
  const empty = fieldStatus({})
  assert.equal(empty.known.length, 0)
  assert.equal(empty.coverage, 0)
  // A false blocker is an ANSWER, not a gap: "no flue" is knowledge.
  const answered = fieldStatus({ hasFlue: false, frontage: 6, area: null })
  assert.ok(answered.known.some(k => k.key === 'hasFlue' && k.value === false))
  assert.ok(answered.known.some(k => k.key === 'frontage' && k.value === 6))
  assert.ok(answered.gaps.some(g => g.key === 'area'))
})

test('every scored metric belongs to a declared group', () => {
  const keys = new Set(METRIC_GROUPS.map(g => g.key))
  for (const m of BENCH_METRICS) {
    assert.ok(m.group === null || keys.has(m.group), `${m.key} has group ${m.group}`)
  }
  // Each group must actually have metrics, or its score is silently dropped
  // and the overall average quietly becomes a two-dimension average.
  for (const g of METRIC_GROUPS) {
    assert.ok(BENCH_METRICS.some(m => m.group === g.key), `group ${g.key} is empty`)
  }
})

test('the overall score averages groups, so adding a metric does not reweight', () => {
  // Build a baseline over the synthetic town so every metric that CAN be
  // computed here gets a real distribution, then check the arithmetic identity.
  const ctx = { index: indexPois(POIS), basemapIndex: indexBasemap(BASEMAP) }
  const model = fitDistrictModel(POIS, ctx)
  assert.ok(model.ready, model.reason)
  const r = rankAgainstReference({ lng: 121.4520, lat: 31.2250 }, POIS, model, ctx)

  const live = r.groups.filter(g => g.score !== null)
  assert.ok(live.length >= 2, `need at least two live groups, got ${live.length}`)

  // The score IS the mean of group scores.
  const byGroup = Math.round(live.reduce((a, g) => a + g.score, 0) / live.length)
  assert.equal(r.score, byGroup)

  // Each group score is the mean of its own metrics' percentiles.
  for (const g of live) {
    assert.equal(g.score, Math.round(g.metrics.reduce((a, m) => a + m.percentile, 0) / g.metrics.length))
  }

  // And when the groups hold different numbers of metrics, that is a DIFFERENT
  // answer from averaging the metrics flat — which is the whole reason for it.
  const sizes = new Set(live.map(g => g.n))
  if (sizes.size > 1) {
    const scored = r.metrics.filter(m => m.group)
    const flat = Math.round(scored.reduce((a, m) => a + m.percentile, 0) / scored.length)
    assert.notEqual(r.score, flat,
      `group-weighted ${r.score} happened to equal flat ${flat}; pick a point where they differ`)
  }
})

test('percentile uses the midrank, so a common zero is not "worst possible"', () => {
  // Half the baseline is 0 — the shape of crossings and parking counts.
  const values = [...Array(50).fill(0), ...Array(50).fill(0).map((_, i) => i + 1)]
  const model = {
    ready: true, kind: 'district', brandLabel: '测试基线', sampleSize: 100, spacing: null,
    metrics: [{ key: 'crossing150', group: 'access', label: '过街', unit: '处', n: 100,
      values, median: 0.5, p10: 0, p25: 0, p75: 25, p90: 45 }],
  }
  const r = rankAgainstReference({ lng: 0, lat: 0 }, [], model, { index: indexPois([]) })
  const row = r.metrics.find(m => m.key === 'crossing150')
  // A point with zero crossings sits with half the district, not below all of it.
  assert.ok(row.percentile >= 20 && row.percentile <= 30,
    `zero should land mid-tie, got ${row.percentile}`)
})

test('a POI layer the dataset never fetched reads as null, not as a measured zero', () => {
  const ctx = { index: indexPois(POIS), basemapIndex: indexBasemap(BASEMAP),
    availableKinds: new Set(POIS.map(p => p.kind)) }
  const f = benchFeatures({ lng: 121.4520, lat: 31.2250 }, POIS, ctx)
  // The synthetic town has no transit layer at all.
  assert.equal(f.busStop300, null)
  assert.equal(f.parking300, null)
  assert.equal(f.crossing150, null)
  // But it does have food, so a genuine count of zero stays a zero.
  const far = benchFeatures({ lng: 122.9, lat: 32.9 }, POIS, ctx)
  assert.equal(far.food500, 0)

  // Without the guard the same call fabricates zeros for all three.
  const blind = benchFeatures({ lng: 121.4520, lat: 31.2250 }, POIS,
    { index: ctx.index, basemapIndex: ctx.basemapIndex })
  assert.equal(blind.busStop300, 0)
})

test('metrics with no data drop out of the score and are named in `missing`', () => {
  const ctx = { index: indexPois(POIS), basemapIndex: indexBasemap(BASEMAP),
    availableKinds: new Set(POIS.map(p => p.kind)) }
  const model = fitDistrictModel(POIS, ctx)
  const r = rankAgainstReference({ lng: 121.4520, lat: 31.2250 }, POIS, model, ctx)
  const missingKeys = r.missing.map(m => m.key)
  for (const key of ['busStop300', 'parking300', 'crossing150']) {
    assert.ok(missingKeys.includes(key), `${key} should be reported missing`)
    assert.ok(!r.metrics.some(m => m.key === key), `${key} must not be scored`)
  }
  // The access group survives on metro distance alone rather than vanishing.
  const access = r.groups.find(g => g.key === 'access')
  assert.equal(access.n, 1)
})

test('streetLength500 counts a segment once even when it spans several cells', () => {
  // One straight 2 km road, far longer than the 0.004° index cell, so it lands
  // in a whole row of buckets and the naive sum counts it once per cell.
  const long = { roads: [{ c: 'local', n: '长街', p: [[121.440, 31.225], [121.461, 31.225]] }], areas: [] }
  const f = streetFeatures({ lng: 121.4505, lat: 31.2250 }, indexBasemap(long))
  // Only the part within 500 m counts: 500 m each way along one road.
  assert.ok(f.streetLength500 > 900 && f.streetLength500 < 1150,
    `expected ~1000 m of street, got ${f.streetLength500}`)
})

test('the severance warning names the road that severs, not the one fronted', () => {
  const map = {
    roads: [
      { c: 'local', n: '陕西北路', p: [[121.4500, 31.2240], [121.4500, 31.2260]] },
      { c: 'expy', n: '延安高架路', p: [[121.4508, 31.2240], [121.4508, 31.2260]] },
    ],
    areas: [],
  }
  const f = streetFeatures({ lng: 121.4500, lat: 31.2250 }, indexBasemap(map))
  assert.equal(f.roadName, '陕西北路')          // what the shop fronts
  assert.equal(f.severingName, '延安高架路')     // what cuts the catchment
  assert.ok(f.severingDist > 50 && f.severingDist < 100, `got ${f.severingDist}`)
})

// ── the simulated commercial layer must stay out of the score ──

import { readFile } from 'node:fs/promises'
import { DATASETS } from '../src/datasets.js'

test('the simulated market layer is not reachable from any scoring context', async () => {
  // The guarantee is structural, not a promise in a comment: benchFeatures
  // reads only from ctx, so if no scoring context can carry market data, no
  // score can depend on it. Passing it in must change nothing.
  const ctx = { index: indexPois(POIS), basemapIndex: indexBasemap(BASEMAP),
    availableKinds: new Set(POIS.map(p => p.kind)) }
  const clean = benchFeatures({ lng: 121.4520, lat: 31.2250 }, POIS, ctx)
  const poisoned = benchFeatures({ lng: 121.4520, lat: 31.2250 }, POIS, {
    ...ctx,
    market: { listings: [{ lng: 121.452, lat: 31.225, rentPerMonth: 999999 }] },
    listings: [{ lng: 121.452, lat: 31.225, rentPerMonth: 999999 }],
  })
  assert.deepEqual(poisoned, clean)

  // And no scored metric names a market field.
  const marketKeys = ['rentPerMonth', 'rentPerSqmDay', 'daily', 'weekday', 'weekend',
    'vacancyRate', 'tier', 'dailyFootfall', 'transferFee', 'avgTicket']
  for (const m of BENCH_METRICS) {
    assert.ok(!marketKeys.includes(m.key), `${m.key} is a market field and must not be scored`)
  }
})

test('every market record is stamped simulated, and the file says who really sells it', async () => {
  for (const [name, spec] of Object.entries(DATASETS)) {
    if (!spec.market) continue
    const doc = JSON.parse(await readFile(new URL(`../src/data/${spec.market}`, import.meta.url), 'utf8'))
    assert.equal(doc.simulated, true, `${name}: file not marked simulated`)
    assert.ok(doc.warning.includes('模拟'), `${name}: no warning text`)
    for (const key of ['listings', 'footfall', 'malls']) {
      assert.ok(doc.counts[key] > 0, `${name}: ${key} is empty`)
    }
    // A consumer that checks one record must be able to trust every record.
    for (const row of doc.listings) assert.equal(row.simulated, true)
    for (const row of doc.malls) assert.equal(row.simulated, true)
    // Naming the real vendor is the point of the schema — without it this is
    // just invented numbers rather than a demonstration of a purchasable feed.
    for (const key of ['listings', 'footfall', 'malls']) {
      assert.ok(doc.vendors[key]?.length > 5, `${name}: no vendor named for ${key}`)
    }
  }
})

test('simulated rent tracks real location quality instead of being noise', async () => {
  const doc = JSON.parse(await readFile(new URL('../src/data/beijing-market.json', import.meta.url), 'utf8'))
  const poi = JSON.parse(await readFile(new URL('../src/data/beijing-poi.json', import.meta.url), 'utf8'))
  const idx = indexPois(poi.pois)
  const nearestMetro = p => {
    const hit = nearestOfKind(idx, p, 'metro_exit')
    return hit ? hit.d : null
  }
  const withMetro = doc.listings.map(l => ({ rent: l.rentPerSqmDay, d: nearestMetro(l) }))
    .filter(x => Number.isFinite(x.d))
  const close = withMetro.filter(x => x.d < 300).map(x => x.rent)
  const far = withMetro.filter(x => x.d > 1200).map(x => x.rent)
  assert.ok(close.length > 20 && far.length > 20, `close ${close.length} far ${far.length}`)
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
  // Not a claim about the real market — a check that the generator is coherent,
  // so the demo cannot show a subway-adjacent unit cheaper than a remote one.
  assert.ok(mean(close) > mean(far) * 1.3,
    `地铁 300m 内均价 ${mean(close).toFixed(2)} 应明显高于 1.2km 外 ${mean(far).toFixed(2)}`)
})

test('adopting a listing answers every field check', async () => {
  const { siteFromListing } = await import('../src/market.js')
  const doc = JSON.parse(await readFile(new URL('../src/data/beijing-market.json', import.meta.url), 'utf8'))

  let street = 0, mall = 0
  for (const listing of doc.listings) {
    const status = fieldStatus(siteFromListing(listing))
    if (listing.inMall) {
      // A mall unit genuinely has no street frontage. That one gap is correct;
      // anything else missing means a field nothing can ever fill.
      assert.deepEqual(status.gaps.map(g => g.key), ['frontage'],
        `${listing.id} (mall): unexpected gaps ${status.gaps.map(g => g.key)}`)
      mall += 1
    } else {
      assert.equal(status.gaps.length, 0,
        `${listing.id}: still missing ${status.gaps.map(g => g.key).join(',')}`)
      street += 1
    }
  }
  assert.ok(street > 400 && mall > 20, `street ${street} mall ${mall}`)
})

test('no field check is orphaned — editable, saved, and asked for by nobody', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  const server = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  const { LISTING_TO_SITE } = await import('../src/market.js')

  // Whatever the UI lets you set as a tri-state must be a declared check, or
  // the user fills in a value the workbench never reads. hasGas was exactly this.
  const tri = [...app.matchAll(/\['(\w+)',\s*'[^']+'\]/g)]
    .map(m => m[1]).filter(k => k.startsWith('has') || k === 'canLicense')
  const checkKeys = new Set(FIELD_CHECKS.map(c => c.key))
  for (const key of new Set(tri)) {
    assert.ok(checkKeys.has(key), `UI edits ${key} but no FIELD_CHECKS entry asks for it`)
  }
  // And every check must survive a save, or the answer is discarded.
  for (const c of FIELD_CHECKS) {
    assert.ok(server.includes(`site.${c.key}`), `normalizeSite drops ${c.key}`)
  }
  // And be fillable from a listing.
  for (const c of FIELD_CHECKS) {
    assert.ok(c.key in LISTING_TO_SITE, `${c.key} cannot be answered by adopting a listing`)
  }
})

test('listing ids stay pinned to the same unit across regenerations', async () => {
  // Listing ids are positional, so the RNG stream is their identity. Adding a
  // draw inside the generation loop renumbers everything after it, and any site
  // a user already adopted silently starts pointing at a different unit — which
  // is exactly what adding `hasGas` did before it was moved to its own pass.
  //
  // These are golden values. If a change to the generator breaks this test, the
  // fix is to draw the new field in a separate pass with its own generator, not
  // to update the numbers below.
  const doc = JSON.parse(await readFile(new URL('../src/data/beijing-market.json', import.meta.url), 'utf8'))
  // Re-pinned after the city extents grew, the POI categories were split and
  // the listing count tripled — all three change the anchor set the generator
  // draws from. A deliberate regeneration is the only reason these should move.
  const pinned = {
    'lst-0006': { areaSqm: 177, rentPerMonth: 15200 },
    'lst-0381': { areaSqm: 181, rentPerMonth: 23600 },
    'lst-0795': { areaSqm: 41, rentPerMonth: 7100 },
  }
  for (const [id, want] of Object.entries(pinned)) {
    const l = doc.listings.find(x => x.id === id)
    assert.ok(l, `${id} disappeared`)
    assert.equal(l.areaSqm, want.areaSqm, `${id} area drifted`)
    assert.equal(l.rentPerMonth, want.rentPerMonth, `${id} rent drifted`)
  }
})

test('rent tracks the tier of the mall next door, not merely its presence', async () => {
  // The model used to add a flat premium for "any mall within 300m", which could
  // not tell 恒隆广场 from a community mall. Per-mall samples are small and noisy,
  // so the check is on the aggregate, which is the signal that matters.
  const doc = JSON.parse(await readFile(new URL('../src/data/shanghai-market.json', import.meta.url), 'utf8'))
  const near = (a, b) => haversine(a, b)
  const tierOf = (p) => {
    let best = null
    for (const m of doc.malls) {
      const d = near(p, m)
      if (d <= 300 && (!best || d < best.d)) best = { d, tier: m.tier }
    }
    return best?.tier || null
  }
  const buckets = {}
  for (const l of doc.listings) {
    const t = tierOf(l) || '无'
    ;(buckets[t] = buckets[t] || []).push(l.rentPerSqmDay)
  }
  const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]
  assert.ok(buckets['高端']?.length > 30, `高端 sample ${buckets['高端']?.length}`)
  assert.ok(median(buckets['高端']) > median(buckets['社区']) * 1.4,
    `高端 ${median(buckets['高端'])} should clearly exceed 社区 ${median(buckets['社区'])}`)
  assert.ok(median(buckets['高端']) > median(buckets['无']) * 1.4,
    `高端 ${median(buckets['高端'])} should clearly exceed no-mall ${median(buckets['无'])}`)
})

test('well-known malls carry their real positioning, not a derived guess', async () => {
  const known = {
    beijing: { 北京SKP: '高端', 侨福芳草地: '高端', 万达广场: '大众', 红桥市场: '社区' },
    shanghai: { 静安嘉里中心: '高端', 环贸iapm: '高端', 芮欧百货: '高端', 永安百货: '大众' },
  }
  for (const [city, want] of Object.entries(known)) {
    const doc = JSON.parse(await readFile(new URL(`../src/data/${city}-market.json`, import.meta.url), 'utf8'))
    for (const [name, tier] of Object.entries(want)) {
      const mall = doc.malls.find(m => m.name.includes(name))
      assert.ok(mall, `${city}: ${name} missing`)
      assert.equal(mall.tier, tier, `${name} came out ${mall.tier}`)
      assert.equal(mall.tierSource, '真实定位', `${name} was guessed, not anchored`)
    }
  }
})

test('datasets are discovered from the data directory, not hard-coded', async () => {
  const { discoverDatasets } = await import('../src/datasets.js')
  const found = discoverDatasets()
  // The two that ship with the plugin must still resolve, with curated labels.
  assert.ok(found.beijing && found.shanghai, `got ${Object.keys(found)}`)
  assert.match(found.beijing.label, /北京/)
  for (const id of ['beijing', 'shanghai']) {
    const d = found[id]
    assert.equal(d.poi, `${id}-poi.json`)
    assert.equal(d.basemap, `${id}-basemap.json`)
    assert.ok(d.bbox && Number.isFinite(d.bbox.minLng), `${id} bbox not parsed from the file head`)
    assert.ok(d.brands.length > 0)
  }
  // A directory with nothing in it yields nothing, rather than throwing.
  assert.deepEqual(discoverDatasets('/nonexistent-dir-for-this-test'), {})
})

test('a POI file with no basemap is not offered as a dataset', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { discoverDatasets } = await import('../src/datasets.js')
  const dir = await mkdtemp(join(tmpdir(), 'ds-discover-'))
  const head = JSON.stringify({ source: 's', license: 'ODbL 1.0', fetchedAt: 'x',
    area: '测试城市', bbox: { minLng: 1, minLat: 2, maxLng: 3, maxLat: 4 }, pois: [], places: [] })
  await writeFile(join(dir, 'lonely-poi.json'), head, 'utf8')
  // Half a dataset cannot draw a map or score 位置质量 — better absent than broken.
  assert.deepEqual(discoverDatasets(dir), {})

  await writeFile(join(dir, 'lonely-basemap.json'), JSON.stringify({ roads: [], areas: [] }), 'utf8')
  const found = discoverDatasets(dir)
  assert.equal(found.lonely?.label, '测试城市', 'label falls back to the file head `area`')
  assert.equal(found.lonely.buildings, null)
  assert.equal(found.lonely.market, null)
})

test('competition is measured against the project format, not always cafés', () => {
  const pois = [
    P('pharmacy', 121.4500, 31.2250, { name: '老百姓大药房' }),
    P('pharmacy', 121.4502, 31.2250, { name: '海王星辰' }),
    P('cafe', 121.4501, 31.2250, { name: '星巴克' }),
    P('cafe', 121.4503, 31.2250, { name: 'Manner' }),
    P('cafe', 121.4504, 31.2250, { name: 'M Stand' }),
  ]
  const at = { lng: 121.4501, lat: 31.2250 }
  const idx = indexPois(pois)
  // A pharmacy competes with pharmacies…
  const asPharmacy = benchFeatures(at, pois, { index: idx, format: 'pharmacy' })
  assert.equal(asPharmacy.rivals500, 2)
  // …and a café with cafés, from the exact same surroundings.
  const asCafe = benchFeatures(at, pois, { index: idx, format: 'cafe' })
  assert.equal(asCafe.rivals500, 3)
  // An unknown format falls back to the whole F&B group rather than to nothing.
  const unknown = benchFeatures(at, pois, { index: idx, format: '不存在的业态' })
  assert.equal(unknown.rivals500, 3)
  // Every declared format's kinds must be real POI kinds the fetcher produces.
  const known = new Set(RETAIL_KINDS)
  for (const f of FORMATS) {
    for (const k of f.kinds) assert.ok(known.has(k), `${f.id} 引用了不存在的 kind: ${k}`)
  }
})

test('the category split does not invalidate datasets fetched before it', () => {
  // Old datasets lump every restaurant under a single `food` kind. If the split
  // simply ignored it, every saved project would silently start reporting a
  // fraction of the restaurants it reported yesterday.
  const legacy = [
    P('food', 121.4500, 31.2250), P('food', 121.4501, 31.2250), P('food', 121.4502, 31.2250),
    P('cafe', 121.4503, 31.2250),
  ]
  const idx = indexPois(legacy)
  const at = { lng: 121.4501, lat: 31.2250 }
  assert.equal(benchFeatures(at, legacy, { index: idx, format: 'cafe' }).food500, 4,
    '餐饮集聚度必须把旧的 food 算进去')
  // A café competes with cafés only — widening it to the legacy bucket would
  // count every restaurant as a rival.
  assert.equal(benchFeatures(at, legacy, { index: idx, format: 'cafe' }).rivals500, 1)
  // 正餐 had no kind of its own before the split, so it does match the bucket.
  assert.equal(benchFeatures(at, legacy, { index: idx, format: 'restaurant' }).rivals500, 3)
  assert.ok(BASELINE_KINDS.includes('food'), '旧数据仍要能建立基线')
})
