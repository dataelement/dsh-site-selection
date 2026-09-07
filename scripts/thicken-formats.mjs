/**
 * Thicken thin business formats so every format can have its own baseline.
 *
 * A format baseline needs ~80 locations before its percentiles mean anything.
 * OpenStreetMap has 9 pet shops in Beijing and 1 laundry in Guangzhou, so those
 * formats fall back to the all-retail baseline and score identically to every
 * other business — which is the thing that makes "开五金店和开星巴克分数一样"
 * true.
 *
 * This does NOT invent locations from an idea of where such shops belong. It
 * resamples the real ones: it reads the feature profile of the format's actual
 * locations, scores every real commercial address in the city by how well it
 * matches that profile, and draws the top-matching addresses. The result is a
 * smoothed version of a thin real sample — closer to a bootstrap than to a
 * fabrication — but it is still synthetic and is written to the simulated
 * layer, never into the OpenStreetMap files.
 *
 *   node scripts/thicken-formats.mjs beijing
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FORMATS, FORMAT_BASELINE_MIN, BASELINE_KINDS, refineKinds,
  indexPois, indexFloorGrid, indexBasemap, benchFeatures, haversine,
} from '../src/model.js'
import { DATASETS } from '../src/datasets.js'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')

// The features that describe "what kind of place is this" — the ones a format's
// real locations actually differ on.
const PROFILE = ['floorArea500', 'metroDist', 'food500', 'mallDist',
  'busStop300', 'streetLinks', 'streetLength500', 'office500', 'residential500']

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const mad = (xs, m) => Math.max(median(xs.map(x => Math.abs(x - m))), 1e-6)

async function main() {
  const city = process.argv[2]
  const spec = DATASETS[city]
  if (!spec) throw new Error(`用法: node scripts/thicken-formats.mjs <${Object.keys(DATASETS).join('|')}>`)

  const read = async f => JSON.parse(await readFile(join(DATA, f), 'utf8'))
  const poiDoc = await read(spec.poi)
  refineKinds(poiDoc.pois)
  const pois = poiDoc.pois
  const base = await read(spec.basemap)
  const floor = spec.floorArea ? await read(spec.floorArea) : null

  const ctx = {
    index: indexPois(pois),
    floorGrid: floor ? indexFloorGrid(floor) : null,
    basemapIndex: indexBasemap({ areas: base.areas, roads: base.roads }),
    availableKinds: new Set(pois.map(p => p.kind)),
  }

  // Candidate hosts: every real commercial address in the city. A synthetic
  // store is placed AT a real address, so it inherits a real location's real
  // surroundings rather than sitting in a field.
  const hosts = pois.filter(p => BASELINE_KINDS.includes(p.kind) && Number.isFinite(p.lng))
  process.stdout.write(`${city}: 计算 ${hosts.length} 个候选地址的特征…`)
  const hostFeat = hosts.map(h => benchFeatures(h, pois, ctx))
  process.stdout.write(' 完成\n')

  const rnd = mulberry32(city.length * 7919 + 20260908)
  const out = []
  for (const fmt of FORMATS) {
    const real = pois.filter(p => fmt.kinds.includes(p.kind) && Number.isFinite(p.lng))
    const need = FORMAT_BASELINE_MIN - real.length
    if (need <= 0) continue
    if (real.length < 8) {
      console.log(`  ${fmt.label.padEnd(14)} 只有 ${real.length} 家真实门店，样本太少、无从平滑，跳过`)
      continue
    }

    // Profile of the real locations: robust centre and spread per feature.
    const realFeat = real.map(p => benchFeatures(p, pois, ctx))
    const prof = {}
    for (const key of PROFILE) {
      const vals = realFeat.map(f => f[key]).filter(Number.isFinite)
      if (vals.length < real.length / 2) continue
      const m = median(vals)
      prof[key] = { m, s: mad(vals, m) }
    }
    const keys = Object.keys(prof)
    if (!keys.length) { console.log(`  ${fmt.label.padEnd(14)} 特征都取不到，跳过`); continue }

    // Distance from the profile, in robust z units. Existing locations of the
    // format are excluded so the draw adds places rather than duplicating them.
    const realSet = new Set(real)
    const ranked = hosts.map((h, i) => {
      if (realSet.has(h)) return null
      const f = hostFeat[i]
      let d = 0, n = 0
      for (const k of keys) {
        const v = f[k]
        if (!Number.isFinite(v)) continue
        d += Math.abs(v - prof[k].m) / prof[k].s
        n += 1
      }
      return n ? { h, d: d / n } : null
    }).filter(Boolean).sort((a, b) => a.d - b.d)

    // Draw from the closest 6× the shortfall, so the result is spread over a
    // plausible band rather than being the 30 single best matches.
    const pool = ranked.slice(0, Math.min(ranked.length, Math.max(need * 6, 120)))
    const picked = []
    const taken = new Set()
    let guard = 0
    while (picked.length < need && guard < need * 60 && pool.length) {
      guard += 1
      const i = Math.floor(rnd() * pool.length)
      if (taken.has(i)) continue
      const cand = pool[i]
      // Keep them apart: a cluster of synthetic shops on one street would skew
      // the very distribution this is meant to describe.
      if (picked.some(p => haversine(p, cand.h) < 220)) continue
      taken.add(i)
      picked.push({ lng: cand.h.lng, lat: cand.h.lat, d: cand.d })
    }

    for (const [i, p] of picked.entries()) {
      out.push({
        id: `syn-${fmt.id}-${String(i + 1).padStart(3, '0')}`,
        simulated: true, kind: fmt.kinds[0], format: fmt.id,
        lng: p.lng, lat: p.lat,
        fit: Number(p.d.toFixed(3)),
      })
    }
    console.log(`  ${fmt.label.padEnd(14)} 真实 ${String(real.length).padStart(3)} 家 → 补 ${String(picked.length).padStart(3)} 家（按真实门店的选址特征平滑扩样）`)
  }

  const marketPath = join(DATA, `${city}-market.json`)
  const market = JSON.parse(await readFile(marketPath, 'utf8'))
  market.syntheticStores = out
  market.syntheticNote = '按各业态真实门店的选址特征平滑扩样得到，用于让样本过少的业态也能建立同业态基线。'
    + '每条都带 simulated:true，界面上会标出「基线含补充样本」。它们不出现在 OpenStreetMap 数据文件里。'
  market.counts.syntheticStores = out.length
  await writeFile(marketPath, JSON.stringify(market), 'utf8')
  console.log(`\n写入 ${city}-market.json：补充门店 ${out.length} 家`)
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1) })
