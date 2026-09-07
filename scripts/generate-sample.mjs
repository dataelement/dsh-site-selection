#!/usr/bin/env node
/**
 * Builds the shipped sample projects.
 *
 *   1. 主理人咖啡厅 · 静安   — your first independent coffee shop, Shanghai
 *   2. 去茶山 · 北京朝阳      — bringing a tea-drink brand into Beijing
 *
 * Honesty contract: nothing in here is fabricated. Every candidate is a real,
 * named commercial address picked by the workbench's own model out of the
 * city's data, chosen to span the score range so the board has contrast.
 * Tenancy facts (area, rent, flue) are left empty because you only learn those
 * by talking to a landlord — inventing them would be the one thing this project
 * has been careful not to do.
 *
 * Run:  node scripts/generate-sample.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fitDistrictModel, rankAgainstReference, indexPois, indexFloorGrid, indexBasemap,
  haversine } from '../src/model.js'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')
const read = f => JSON.parse(readFileSync(join(DATA, f), 'utf8'))

const SCENARIOS = [
  {
    file: 'sample-shanghai-coffee.json',
    dataset: 'shanghai',
    poi: 'shanghai-poi.json',
    floor: 'shanghai-floorarea.json',
    basemap: 'shanghai-basemap.json',
    districtLabel: '静安—南京西路',
    project: { city: '上海', format: '咖啡', brand: '', referenceBrand: '', targetCount: 1,
      rivals: { brands: [], cuisines: [] }, requirements: { areaMin: 40, areaMax: 90, rentMax: null } },
    intro: '示例场景：你要在上海静安—南京西路一带开第一家主理人咖啡厅。',
    kinds: ['cafe', 'food', 'mall'],
    // Recalibrated after the criteria rework: scoring three dimensions instead
    // of one flat list makes a top score harder to reach, so the old 85+ band
    // came back empty and the sample lost a site.
    bands: [[74, 100], [60, 73], [46, 59], [34, 45], [0, 33]],
  },
  {
    file: 'sample-beijing-tea.json',
    dataset: 'beijing',
    poi: 'beijing-poi.json',
    floor: 'beijing-floorarea.json',
    basemap: 'beijing-basemap.json',
    districtLabel: '朝阳区及邻近',
    project: { city: '北京', format: '茶饮', brand: '去茶山', referenceBrand: '', targetCount: 3,
      rivals: { brands: ['喜茶', '奈雪', '蜜雪冰城', '茶百道', '古茗', '霸王茶姬', '沪上阿姨', 'CoCo', '一点点'], cuisines: [] },
      requirements: { areaMin: 25, areaMax: 70, rentMax: null } },
    intro: '示例场景：茶饮品牌「去茶山」要进北京，先在朝阳区开出前 3 家。',
    // The POI set reaches into 东城/西城/海淀东部; keep the candidates inside
    // Chaoyang so the scenario means what it says.
    area: { minLng: 116.420, minLat: 39.850, maxLng: 116.640, maxLat: 40.020 },
    kinds: ['cafe', 'food', 'mall'],
    bands: [[85, 100], [72, 84], [60, 71], [45, 59], [30, 44], [0, 29]],
  },
]

for (const sc of SCENARIOS) {
  const doc = read(sc.poi)
  const pois = doc.pois
  const floorGrid = indexFloorGrid(read(sc.floor))
  const index = indexPois(pois)
  const base = read(sc.basemap)
  // Same context the running workbench uses, or the sample would be scored by a
  // different model than the one the user sees when they click the same point.
  const ctx = { index, floorGrid, districtLabel: sc.districtLabel,
    basemapIndex: indexBasemap({ areas: base.areas, roads: base.roads }),
    availableKinds: new Set(pois.map(p => p.kind)) }
  const model = fitDistrictModel(pois, ctx)

  const scored = []
  for (const p of pois) {
    if (!p.name || !sc.kinds.includes(p.kind)) continue
    if (sc.area && (p.lng < sc.area.minLng || p.lng > sc.area.maxLng
      || p.lat < sc.area.minLat || p.lat > sc.area.maxLat)) continue
    const r = rankAgainstReference(p, pois, model, ctx)
    if (r.score === null) continue
    scored.push({ p, r })
  }
  scored.sort((a, b) => b.r.score - a.r.score)

  // One candidate per score band, kept ≥900 m apart so they are genuinely
  // different pitches rather than several doors on one street.
  const picked = []
  for (const [lo, hi] of sc.bands) {
    const pool = scored.filter(({ p, r }) => r.score >= lo && r.score <= hi
      && picked.every(q => haversine(q.p, p) > 900))
    if (pool.length) picked.push(pool[Math.floor(pool.length / 3)])
  }

  /** Name a pitch by where it is, not by whoever happens to trade there today. */
  const label = ({ p, r }, i) => {
    const near = r.features.mallName && r.features.mallDist < 260 ? r.features.mallName
      : r.features.metroName && r.features.metroDist < 300 ? `${r.features.metroName}站`
      : p.name
    return `点位 ${'ABCDEFG'[i]} · ${r.features.districtType} · 近${near}`
  }

  const now = new Date().toISOString()
  const sites = picked.map((row, i) => ({
    id: `site-0${i + 1}`,
    name: label(row, i),
    address: `近 ${row.p.name}`,
    lng: row.p.lng, lat: row.p.lat,
    area: null, frontage: null, floor: 1, rent: null, transferFee: null, landlord: '',
    hasFlue: null, canLicense: null, hasGas: null,
    source: '示例项目', status: 'tovisit', fieldNotes: [], decision: null,
    createdAt: now, updatedAt: now,
  }))

  const dataNote = sc.intro
    + `这 ${sites.length} 个候选点位是工作台用自己的评分模型，从本区 ${scored.length} 个真实商业地址里挑出来的，`
    + `分数覆盖 ${picked.at(-1).r.score}–${picked[0].r.score} 分，故意拉开差距方便对比。`
    + '所有坐标、周边数据、地图都来自 OpenStreetMap，未经修改。'
    + '面积、租金、排烟条件留空——那些要谈过房东才知道，工作台不替你编。'

  writeFileSync(join(DATA, sc.file),
    JSON.stringify({ project: sc.project, dataset: sc.dataset, dataNote, generatedAt: now, sites }, null, 2))

  console.log(`\n■ ${sc.file}　基线 ${model.brandLabel} ${model.sampleSize} 个位置，候选池 ${scored.length}`)
  for (let i = 0; i < picked.length; i += 1) {
    const { r } = picked[i]
    console.log(`  ${String(r.score).padStart(3)} 分  ${sites[i].name}`)
    console.log(`          ${r.features.districtType}  地铁 ${r.features.metroDist}m  500m 餐饮 ${r.features.food500}  同类 ${r.features.cafe500}  建筑面积 ${r.features.floorArea500 ? (r.features.floorArea500 / 1e4).toFixed(0) + '万㎡' : '—'}`)
    for (const f of r.flags) console.log(`          ⚠ ${f.text.slice(0, 60)}`)
  }
}
