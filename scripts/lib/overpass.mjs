/**
 * A stubborn Overpass client.
 *
 * Every defence here is the result of a run that died: the public endpoints are
 * free, heavily used, and fail in several different ways that all look like
 * success until you read the body. Do not simplify this without reproducing a
 * whole-city fetch first.
 */
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// The main instance rate-limits hard after a few hundred tile queries and then
// refuses connections outright, so a full city run needs somewhere else to go.
export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))
let endpointIndex = 0

async function once(body) {
  return fetch(ENDPOINTS[endpointIndex], {
    method: 'POST',
    // Overpass answers 406 to a bare fetch(); it wants an identifiable client.
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'dsh-site-selection/1.0 (city dataset builder)',
      accept: 'application/json',
    },
    body: new URLSearchParams({ data: body }),
  })
}

export async function overpass(body, attempt = 0) {
  // The retry has to wrap reading the body too, not just opening the connection:
  // these endpoints drop large responses mid-stream ("terminated"), which throws
  // from res.json() long after fetch() has already resolved.
  try {
    const res = await once(body)
    if (res.status === 429 || res.status === 504) throw new Error(`Overpass ${res.status}`)
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      throw Object.assign(new Error(`Overpass ${res.status}: ${detail}`), { fatal: res.status < 500 })
    }
    return await res.json()
  } catch (error) {
    if (error.fatal || attempt >= 8) throw error
    // Rotate mirrors rather than hammering the one that just refused us.
    endpointIndex = (endpointIndex + 1) % ENDPOINTS.length
    await sleep(5000 * (attempt + 1))
    return overpass(body, attempt + 1)
  }
}

/** Split a bbox into Overpass-sized tiles, south,west,north,east strings. */
export function tilesFor(bbox, step) {
  const out = []
  for (let lat = bbox.minLat; lat < bbox.maxLat; lat += step) {
    for (let lng = bbox.minLng; lng < bbox.maxLng; lng += step) {
      out.push([lat, lng, Math.min(lat + step, bbox.maxLat), Math.min(lng + step, bbox.maxLng)]
        .map(v => v.toFixed(6)).join(','))
    }
  }
  return out
}

/**
 * Run one query over every tile, checkpointing after each.
 *
 * A whole city is a few hundred throttled requests over an hour or more, and
 * some run will die partway through. Without a checkpoint the next attempt
 * starts from zero — the first version of this lost 5639 finished bus stops to
 * a dropped connection on the pass that followed.
 *
 * @param accept called per element; return a record to keep it, or null to skip
 */
export async function harvest({ label, tiles, query, accept, ckptPath, pause = 2000 }) {
  let done = 0
  const found = new Map()
  try {
    const saved = JSON.parse(await readFile(ckptPath, 'utf8'))
    if (saved.label === label) {
      done = saved.done || 0
      for (const [k, v] of saved.rows) found.set(k, v)
      if (done) process.stdout.write(`  ${label}: 续传，已完成 ${done}/${tiles.length} 瓦片，${found.size} 条\n`)
    }
  } catch { /* no checkpoint yet */ }

  for (let i = done; i < tiles.length; i += 1) {
    const json = await overpass(query(tiles[i]))
    for (const el of json.elements || []) {
      const id = `${el.type[0]}${el.id}`
      if (found.has(id)) continue
      const row = accept(el, id)
      if (row) found.set(id, row)
    }
    await mkdir(dirname(ckptPath), { recursive: true })
    await writeFile(ckptPath, JSON.stringify({ label, done: i + 1, rows: [...found] }), 'utf8')
    process.stdout.write(`\r  ${label}: 瓦片 ${i + 1}/${tiles.length}，累计 ${found.size}      `)
    await sleep(pause)   // be a polite client of a free public endpoint
  }
  process.stdout.write('\n')
  await unlink(ckptPath).catch(() => {})
  return [...found.values()]
}

/** Element → point. Ways and relations report `center` thanks to `out center`. */
export function centroid(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { lng: el.lon, lat: el.lat }
  if (el.center) return { lng: el.center.lon, lat: el.center.lat }
  return null
}
