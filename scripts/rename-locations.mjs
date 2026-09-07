#!/usr/bin/env node
/**
 * Rename candidate locations that were named after whatever shop stands there.
 *
 * query-sites.mjs used to take the POI's own name, so a Popeyes project ended
 * up with candidates called 肯德基 and 麦当劳 — three of them 星巴克, none
 * distinguishable. New candidates are named `路名 · 近XX`; this brings existing
 * ones in line.
 *
 * Only touches locations the tool added itself (`source` starts with「DSH 查询」)
 * and whose name has not been edited by hand, so nothing a person typed is lost.
 *
 *   node scripts/rename-locations.mjs "<项目文件夹>"          # 预览
 *   node scripts/rename-locations.mjs "<项目文件夹>" --apply   # 写入
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexPois, indexBasemap, indexFloorGrid, benchFeatures, refineKinds } from '../src/model.js'
import { DATASETS } from '../src/datasets.js'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')

const projectDir = resolve(process.argv[2] || process.cwd())
const apply = process.argv.includes('--apply')

const statePath = join(projectDir, 'project.json')
const state = JSON.parse(await readFile(statePath, 'utf8'))
const spec = DATASETS[state.project?.dataset]
if (!spec) { console.error('这个项目没有绑定城市数据集。'); process.exit(1) }

const read = async f => JSON.parse(await readFile(join(DATA, f), 'utf8'))
const poiDoc = await read(spec.poi)
refineKinds(poiDoc.pois)
const base = await read(spec.basemap)
const ctx = {
  index: indexPois(poiDoc.pois),
  floorGrid: spec.floorArea ? indexFloorGrid(await read(spec.floorArea)) : null,
  basemapIndex: indexBasemap({ areas: base.areas, roads: base.roads }),
  availableKinds: new Set(poiDoc.pois.map(p => p.kind)),
  format: state.project.format,
}

let changed = 0
for (const site of state.sites || []) {
  if (site.kind === 'unit') continue
  if (!Number.isFinite(site.lng)) continue
  if (!String(site.source || '').startsWith('DSH 查询')) continue
  // Already in the new shape, or renamed by a person.
  if (site.name.includes(' · ')) continue

  const f = benchFeatures(site, poiDoc.pois, ctx)
  const road = f.roadName
  // Without a road name the rename produces「近广百百货」, which says less than
  // the original. Leave those alone.
  if (!road) continue
  const next = `${road} · 近${site.name}`
  if (next === site.name) continue
  console.log(`  ${site.name.padEnd(20)} → ${next}`)
  if (apply) { site.name = next; site.updatedAt = new Date().toISOString() }
  changed += 1
}

if (!changed) { console.log('没有需要改名的位置。'); process.exit(0) }
if (!apply) { console.log(`\n共 ${changed} 个。加 --apply 才会写入。`); process.exit(0) }
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log(`\n已改名 ${changed} 个，界面几秒内自动刷新。`)
