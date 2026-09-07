/**
 * The city datasets available to the workbench.
 *
 * Discovered from what is actually in src/data/, not hard-coded. A dataset is
 * any `<id>-poi.json` with a matching `<id>-basemap.json`; the buildings, floor
 * area and simulated-market files are optional and light up extra features when
 * present. That means `scripts/fetch-city.mjs` is enough to add a city — no code
 * change, no rebuild, and the plugin is useful to someone who works in a city
 * nobody thought to ship.
 *
 * This table also used to be declared twice — once here and once in
 * scripts/query-sites.mjs — and the copies drifted, so a location DSH scored
 * from the command line came out different from the same location clicked in
 * the UI. One source, all callers.
 */
import { readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

/**
 * Curated extras for the cities that ship with the plugin: a nicer label than
 * the raw `area` string, and a reference-brand list for the optional
 * "benchmark against this chain" mode.
 */
const CURATED = {
  beijing: {
    label: '北京 · 五环内',
    brands: ['星巴克', '瑞幸', 'manner', '库迪', '喜茶', '霸王茶姬', '蜜雪冰城', '屈臣氏', '罗森', '便利蜂'],
  },
  shanghai: {
    label: '上海 · 外环内',
    brands: ['星巴克', 'manner', '瑞幸', 'tims', '喜茶', '奈雪', '全家', '罗森', '屈臣氏'],
  },
  guangzhou: {
    label: '广州 · 主城区',
    brands: ['星巴克', '瑞幸', '喜茶', '蜜雪冰城', '美宜佳', '屈臣氏', '7-11'],
  },
}
// Suggestions only — the brand field takes free text, so this list never limits
// what can be asked for.
const DEFAULT_BRANDS = ['星巴克', '瑞幸', '喜茶', '蜜雪冰城', '屈臣氏', '罗森']

/**
 * Pull `area` and `bbox` out of a dataset head without parsing the whole file.
 * A city POI file is a few megabytes and this runs for every dataset at
 * startup; the fields are written first, so the first few KB always contain
 * them. Anything unexpected falls back to the id rather than throwing.
 */
function readHead(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const area = /"area":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]
    const bboxRaw = /"bbox":(\{[^}]*\})/.exec(text)?.[1]
    let bbox = null
    if (bboxRaw) { try { bbox = JSON.parse(bboxRaw) } catch { bbox = null } }
    return { area: area || '', bbox }
  } catch {
    return { area: '', bbox: null }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function discoverDatasets(dir = DATA_DIR) {
  let names
  try { names = readdirSync(dir) } catch { return {} }
  const has = new Set(names)
  const out = {}
  for (const name of names.sort()) {
    const id = /^(.+)-poi\.json$/.exec(name)?.[1]
    // A POI file with no basemap cannot draw a map or score 位置质量, so it is
    // not a usable dataset — better absent than half-working.
    if (!id || !has.has(`${id}-basemap.json`)) continue
    const { area, bbox } = readHead(join(dir, name))
    const curated = CURATED[id] || {}
    out[id] = {
      label: curated.label || area || id,
      bbox,
      poi: name,
      basemap: `${id}-basemap.json`,
      buildings: has.has(`${id}-buildings.json`) ? `${id}-buildings.json` : null,
      floorArea: has.has(`${id}-floorarea.json`) ? `${id}-floorarea.json` : null,
      market: has.has(`${id}-market.json`) ? `${id}-market.json` : null,
      brands: curated.brands || DEFAULT_BRANDS,
    }
  }
  return out
}

export const DATASETS = discoverDatasets()
