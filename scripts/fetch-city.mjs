/**
 * Build a complete city dataset from OpenStreetMap.
 *
 * This is what makes the workbench usable outside the two cities that happen to
 * ship with it. Run it once per city and the workbench picks the result up on
 * its next start — no code change.
 *
 *   node scripts/fetch-city.mjs --id shenzhen-futian \
 *     --label "深圳 · 福田区" --bbox 113.90,22.50,114.10,22.60
 *
 * It writes four files into src/data/, all derived from OpenStreetMap and
 * therefore ODbL 1.0 — see DATA-LICENSE.md before redistributing them.
 *
 *   <id>-poi.json        shops, offices, homes, transit, crossings, parking
 *   <id>-basemap.json    road network and land use, for the map and for 位置质量
 *   <id>-buildings.json  tall building outlines, for the 3D view
 *   <id>-floorarea.json  floor-area grid, the traffic-base proxy
 *
 * Expect it to take a while: Overpass is a free service and this is polite to
 * it. The run checkpoints after every tile, so an interrupted fetch resumes
 * where it stopped — just run the same command again.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harvest, tilesFor, centroid } from './lib/overpass.mjs'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data')
const CKPT = join(DATA, '.cache')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const LICENSE = 'ODbL 1.0'
const SOURCE = 'OpenStreetMap contributors, via Overpass API'
const NOTE = '真实公开数据，未经修改。商业版应替换为持牌服务商（高德/百度）数据。'

// ── geometry ─────────────────────────────────────────────
const M_PER_DEG_LAT = 110540
const mPerDegLng = lat => 111320 * Math.cos((lat * Math.PI) / 180)

/** Ring area in m², shoelace in a local flat projection. */
function ringArea(ring, lat) {
  const kx = mPerDegLng(lat)
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] * kx) * (ring[i][1] * M_PER_DEG_LAT)
      - (ring[i][0] * kx) * (ring[j][1] * M_PER_DEG_LAT)
  }
  return Math.abs(sum) / 2
}

/**
 * Douglas–Peucker. OSM ways carry far more points than a map at this zoom can
 * show, and the untrimmed road network was several times the size of everything
 * else in the package put together.
 */
function simplify(points, epsDeg) {
  if (points.length < 3) return points
  let maxDist = 0, index = 0
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1]
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i]
    let d
    if (len2 === 0) d = Math.hypot(px - ax, py - ay)
    else {
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
      d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }
    if (d > maxDist) { maxDist = d; index = i }
  }
  if (maxDist <= epsDeg) return [points[0], points[points.length - 1]]
  return [...simplify(points.slice(0, index + 1), epsDeg).slice(0, -1),
    ...simplify(points.slice(index), epsDeg)]
}

const round6 = v => Number(v.toFixed(6))
// 5 decimals is ~1 m here, which is finer than the simplification tolerance and
// finer than anything the map can draw. The extra digit is pure file size, and
// road geometry is the single largest thing in the package.
const round5 = v => Number(v.toFixed(5))
const geom = el => (el.geometry || []).filter(p => p).map(p => [round5(p.lon), round5(p.lat)])

// ── POI classification ───────────────────────────────────
// `cat` and `pri` drive map label priority and are only carried by named POIs;
// an unnamed one is stored as four fields, which is most of why the POI file is
// 2.8 MB rather than 12.
const KINDS = [
  // ── 餐饮 ──
  ['restaurant', t => t.amenity === 'restaurant', 'food', 4],
  ['fastfood', t => ['fast_food', 'food_court'].includes(t.amenity), 'food', 4],
  ['cafe', t => t.amenity === 'cafe' || t.shop === 'coffee', 'food', 3],
  ['teadrink', t => t.shop === 'bubble_tea' || /bubble_tea|tea/.test(t.cuisine || '')
    || (t.amenity === 'cafe' && /tea/.test(t.cuisine || '')), 'food', 3],
  ['bakery', t => t.shop === 'bakery' || t.shop === 'pastry', 'food', 3],
  ['bar', t => ['bar', 'pub', 'nightclub'].includes(t.amenity), 'food', 3],
  ['dessert', t => ['ice_cream', 'confectionery', 'chocolate'].includes(t.shop) || t.amenity === 'ice_cream', 'food', 2],

  // ── 零售 ──
  ['convenience', t => t.shop === 'convenience' || t.shop === 'kiosk', 'shop', 3],
  ['supermarket', t => ['supermarket', 'greengrocer', 'butcher', 'seafood'].includes(t.shop), 'shop', 2],
  ['mall', t => ['mall', 'department_store'].includes(t.shop), 'shop', 1],
  ['clothes', t => ['clothes', 'boutique', 'shoes', 'bag', 'fashion_accessories'].includes(t.shop), 'shop', 4],
  ['cosmetics', t => ['cosmetics', 'perfumery', 'beauty'].includes(t.shop), 'shop', 4],
  ['jewelry', t => ['jewelry', 'watches'].includes(t.shop), 'shop', 4],
  ['optician', t => t.shop === 'optician', 'shop', 4],
  ['electronics', t => ['electronics', 'mobile_phone', 'computer', 'hifi'].includes(t.shop), 'shop', 4],
  ['books', t => ['books', 'stationery', 'newsagent'].includes(t.shop), 'shop', 4],
  ['homeware', t => ['furniture', 'houseware', 'hardware', 'doityourself', 'appliance', 'interior_decoration'].includes(t.shop), 'shop', 4],
  ['sports', t => ['sports', 'bicycle', 'outdoor'].includes(t.shop), 'shop', 4],
  ['toys', t => ['toys', 'baby_goods', 'games'].includes(t.shop), 'shop', 4],
  ['pet', t => ['pet', 'pet_grooming'].includes(t.shop), 'shop', 4],
  ['florist', t => ['florist', 'garden_centre'].includes(t.shop), 'shop', 4],
  ['pharmacy', t => t.amenity === 'pharmacy' || t.shop === 'chemist' || t.shop === 'medical_supply', 'shop', 3],
  ['tobacco', t => ['tobacco', 'alcohol', 'wine'].includes(t.shop), 'shop', 4],

  // ── 生活服务 ──
  ['hairdresser', t => ['hairdresser', 'massage', 'nail', 'tattoo'].includes(t.shop), 'life', 4],
  ['laundry', t => ['laundry', 'dry_cleaning', 'tailor'].includes(t.shop), 'life', 4],
  ['gym', t => t.leisure === 'fitness_centre' || t.shop === 'sports' && t.fitness === 'yes'
    || ['gym', 'fitness'].includes(t.leisure), 'life', 4],
  ['repair', t => ['car_repair', 'mobile_phone_repair', 'repair', 'electronics_repair'].includes(t.shop), 'life', 4],
  ['education', t => ['language_school', 'music_school', 'driving_school', 'training'].includes(t.amenity)
    || ['music', 'art'].includes(t.shop), 'edu', 4],

  // ── 周边环境（不是可开的业态，是需求信号）──
  ['metro_exit', t => t.railway === 'subway_entrance', 'transit', 2],
  ['metro', t => (t.railway === 'station' || t.public_transport === 'station')
    && (t.station === 'subway' || t.subway === 'yes'), 'transit', 1],
  ['bus', t => t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes'), 'transit', 3],
  ['parking', t => t.amenity === 'parking' && t.access !== 'private', 'transit', 2],
  ['crossing', t => t.highway === 'crossing' || t.footway === 'crossing', 'transit', 1],
  ['campus', t => ['university', 'college'].includes(t.amenity), 'edu', 2],
  ['school', t => ['school', 'kindergarten'].includes(t.amenity), 'edu', 4],
  ['hospital', t => ['hospital', 'clinic', 'doctors'].includes(t.amenity), 'health', 2],
  ['hotel', t => ['hotel', 'hostel', 'guest_house'].includes(t.tourism), 'stay', 3],
  ['office', t => Boolean(t.office) || t.building === 'office', 'work', 5],
  ['residential', t => ['residential', 'apartments', 'house', 'dormitory'].includes(t.building), '', 0],
]

const ROAD_CLASS = {
  motorway: 'expy', trunk: 'expy',
  primary: 'major',
  secondary: 'minor',
  tertiary: 'local', residential: 'local', unclassified: 'local', living_street: 'local',
  motorway_link: 'link', trunk_link: 'link', primary_link: 'link', secondary_link: 'link', tertiary_link: 'link',
}
const AREA_CLASS = t => {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir') return 'water'
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'village_green') return 'park'
  if (['commercial', 'retail'].includes(t.landuse)) return 'commercial'
  if (t.landuse === 'residential') return 'residential'
  if (['grass', 'forest', 'meadow', 'recreation_ground'].includes(t.landuse) || t.leisure === 'pitch') return 'green'
  if (['industrial', 'railway'].includes(t.landuse)) return 'industrial'
  return null
}

/** Height in metres, and whether it was measured or inferred. */
function heightOf(t) {
  const raw = parseFloat(String(t.height || t['building:height'] || '').replace(/[^\d.]/g, ''))
  if (Number.isFinite(raw) && raw > 0) return { h: raw, known: 1 }
  const levels = parseFloat(t['building:levels'])
  if (Number.isFinite(levels) && levels > 0) return { h: levels * 3.2, known: 0 }
  return null
}
function levelsOf(t) {
  const levels = parseFloat(t['building:levels'])
  if (Number.isFinite(levels) && levels > 0) return levels
  const h = heightOf(t)
  return h ? Math.max(1, Math.round(h.h / 3.2)) : 1
}

async function main() {
  const id = flag('id')
  const label = flag('label')
  const bboxArg = flag('bbox')
  if (!id || !label || !bboxArg) {
    console.error(`用法：
  node scripts/fetch-city.mjs --id <数据集id> --label "<显示名>" --bbox <minLng,minLat,maxLng,maxLat>

例：
  node scripts/fetch-city.mjs --id shenzhen-futian --label "深圳 · 福田区" \\
    --bbox 113.90,22.50,114.10,22.60

可选：
  --tile 0.06         瓦片边长（度）。越小越不容易超时，但请求数越多
  --min-height 18     进三维图的最低建筑高度（米）
  --area "<说明>"     写进文件的范围说明，默认用 label`)
    process.exit(1)
  }
  const [minLng, minLat, maxLng, maxLat] = bboxArg.split(',').map(Number)
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite) || minLng >= maxLng || minLat >= maxLat) {
    console.error('--bbox 格式错误，要 minLng,minLat,maxLng,maxLat 且 min < max')
    process.exit(1)
  }
  const bbox = { minLng, minLat, maxLng, maxLat }
  const area = flag('area', label)
  const tile = Number(flag('tile', 0.06))
  const minHeight = Number(flag('min-height', 18))
  const tiles = tilesFor(bbox, tile)
  const fetchedAt = new Date().toISOString()
  const head = { source: SOURCE, license: LICENSE, fetchedAt, area, bbox, note: NOTE }

  await mkdir(CKPT, { recursive: true })
  const km = (maxLng - minLng) * mPerDegLng((minLat + maxLat) / 2) / 1000
  const kmLat = (maxLat - minLat) * M_PER_DEG_LAT / 1000
  console.log(`${label}　范围约 ${km.toFixed(0)}×${kmLat.toFixed(0)} km，切成 ${tiles.length} 个瓦片`)
  console.log('Overpass 是免费服务，这一步会比较慢。中断了重跑同一条命令即可续传。\n')

  // ── 1. POI ─────────────────────────────────────────────
  const poiQuery = box => `[out:json][timeout:240];(
    nwr["amenity"~"^(restaurant|fast_food|food_court|cafe|bar|pub|nightclub|ice_cream|pharmacy|school|kindergarten|university|college|hospital|clinic|doctors|parking|language_school|music_school|driving_school|training)$"](${box});
    nwr["shop"](${box});
    nwr["office"](${box});
    nwr["tourism"~"^(hotel|hostel|guest_house)$"](${box});
    nwr["leisure"~"^(fitness_centre|gym|fitness)$"](${box});
    nwr["building"~"^(residential|apartments|dormitory|office)$"](${box});
    node["railway"="subway_entrance"](${box});
    nwr["railway"="station"](${box});
    node["highway"~"^(bus_stop|crossing)$"](${box});
    way["footway"="crossing"](${box});
  );out center;`

  const pois = await harvest({
    label: 'POI', tiles, query: poiQuery, ckptPath: join(CKPT, `${id}-poi.json`),
    accept: (el, elId) => {
      const t = el.tags || {}
      const at = centroid(el)
      if (!at) return null
      const hit = KINDS.find(([, test]) => test(t))
      if (!hit) return null
      const [kind, , cat, pri] = hit
      const row = { id: elId, kind, lng: round6(at.lng), lat: round6(at.lat) }
      // Named POIs carry display metadata; unnamed ones stay minimal.
      if (t.name && cat) { row.name = String(t.name).slice(0, 40); row.cat = cat; row.pri = pri }
      return row
    },
  })

  const places = await harvest({
    label: '地名', tiles, query: box => `[out:json][timeout:180];(
      node["place"~"^(suburb|quarter|neighbourhood|city_block)$"](${box});
      nwr["leisure"~"^(park|garden)$"]["name"](${box});
    );out center;`,
    ckptPath: join(CKPT, `${id}-places.json`),
    accept: (el, elId) => {
      const t = el.tags || {}
      const at = centroid(el)
      if (!at || !t.name) return null
      return { id: elId, kind: 'place', lng: round6(at.lng), lat: round6(at.lat),
        name: String(t.name).slice(0, 40), cat: t.leisure ? 'park' : 'place', pri: t.leisure ? 2 : 3 }
    },
  })

  await writeFile(join(DATA, `${id}-poi.json`), JSON.stringify({ ...head, pois, places }), 'utf8')
  const tally = {}
  for (const p of pois) tally[p.kind] = (tally[p.kind] || 0) + 1
  console.log(`  → ${id}-poi.json　${pois.length} POI（${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('，')}），${places.length} 地名\n`)

  // ── 2. basemap ─────────────────────────────────────────
  const roads = await harvest({
    label: '路网', tiles, ckptPath: join(CKPT, `${id}-roads.json`),
    query: box => `[out:json][timeout:180];way["highway"~"^(${Object.keys(ROAD_CLASS).join('|')})$"](${box});out geom;`,
    accept: (el, elId) => {
      const cls = ROAD_CLASS[el.tags?.highway]
      const pts = simplify(geom(el), 0.00004)
      if (!cls || pts.length < 2) return null
      const row = { c: cls, p: pts }
      if (el.tags?.name) row.n = String(el.tags.name).slice(0, 40)
      return row
    },
  })
  const areas = await harvest({
    label: '用地', tiles, ckptPath: join(CKPT, `${id}-areas.json`),
    query: box => `[out:json][timeout:180];(
      way["landuse"](${box}); way["leisure"~"^(park|garden|pitch)$"](${box});
      way["natural"="water"](${box}); way["waterway"="riverbank"](${box});
    );out geom;`,
    accept: (el, elId) => {
      const cls = AREA_CLASS(el.tags || {})
      const pts = simplify(geom(el), 0.00008)
      if (!cls || pts.length < 3) return null
      return { c: cls, p: pts }
    },
  })
  await writeFile(join(DATA, `${id}-basemap.json`), JSON.stringify({ ...head, roads, areas }), 'utf8')
  console.log(`  → ${id}-basemap.json　${roads.length} 条路，${areas.length} 块用地\n`)

  // ── 3+4. buildings and the floor-area grid, from one pass ──
  // Every building contributes to the grid; only the tall ones are kept as
  // outlines, because the 3D view cannot show a whole city of low-rise and the
  // file would be enormous.
  const GRID = 0.0012
  const cells = new Map()
  const buildings = await harvest({
    label: '建筑', tiles, ckptPath: join(CKPT, `${id}-buildings.json`),
    query: box => `[out:json][timeout:240];way["building"](${box});out geom;`,
    accept: (el, elId) => {
      const t = el.tags || {}
      const ring = geom(el)
      if (ring.length < 3) return null
      const lat = ring[0][1]
      const foot = ringArea(ring, lat)
      if (foot > 0) {
        const key = `${Math.round(ring[0][0] / GRID)},${Math.round(lat / GRID)}`
        cells.set(key, (cells.get(key) || 0) + foot * levelsOf(t))
      }
      const h = heightOf(t)
      if (!h || h.h < minHeight) return null
      const row = { r: simplify(ring, 0.00002), h: Math.round(h.h * 10) / 10, k: h.known }
      if (t.name) row.n = String(t.name).slice(0, 40)
      return row
    },
  })
  await writeFile(join(DATA, `${id}-buildings.json`), JSON.stringify({
    ...head, count: buildings.length,
    note: `${NOTE} 只含高度 ≥${minHeight} m 的建筑。`, buildings,
  }), 'utf8')

  const cellRows = [...cells].map(([k, v]) => {
    const [x, y] = k.split(',').map(Number)
    return [x, y, Math.round(v)]
  })
  await writeFile(join(DATA, `${id}-floorarea.json`), JSON.stringify({
    source: SOURCE, license: LICENSE, fetchedAt, area,
    grid: GRID, coverage: bbox, cells: cellRows,
    note: `${NOTE} 由建筑轮廓面积 × 层数逐格累加，层数缺失时按 1 层计。`,
  }), 'utf8')
  console.log(`  → ${id}-buildings.json　${buildings.length} 栋 ≥${minHeight}m`)
  console.log(`  → ${id}-floorarea.json　${cellRows.length} 个网格\n`)

  console.log(`完成。把这个数据集加进 src/datasets.js 的 DATASETS，或直接重启 DSH——`)
  console.log(`工作台会自动发现 src/data/ 下成套的数据文件。`)
  console.log(`\n⚠ 这四个文件是 OpenStreetMap 的衍生数据库，受 ODbL 1.0 约束。对外分发前请读 DATA-LICENSE.md。`)
}

main().catch(e => { console.error('\n' + (e.stack || e.message)); process.exit(1) })
