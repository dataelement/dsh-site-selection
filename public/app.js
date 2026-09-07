import { rankAgainstReference, indexFloorGrid, indexPois, indexBasemap, TIER_LABEL,
  METRIC_GROUPS, BENCH_METRICS, CUSTOMER_SEGMENTS, RETAIL_KINDS, rivalKindsOf, formatOf,
  haversine } from './model.js'

const RETAIL_LAYER_KINDS = new Set(RETAIL_KINDS)

const $ = id => document.getElementById(id)
const project = new URLSearchParams(location.search).get('project') || ''
const api = (path, extra = {}) => `${path}?${new URLSearchParams({ project, ...extra })}`

const FIELDS = ['name', 'address', 'area', 'frontage', 'floor', 'rent', 'transferFee', 'landlord',
  'ceilingM', 'powerKw']
const NUMS = new Set(['area', 'frontage', 'floor', 'rent', 'transferFee', 'ceilingM', 'powerKw'])
const TRI = [['hasFlue', '排烟'], ['canLicense', '证照'], ['hasWater', '上下水'], ['hasGas', '燃气']]
// 待看 → 看过 → 上会中 → 已签约 / 已否决. The old first stage 待初筛 is gone:
// a site was added and the very next click already meant "go and see it".
const STATUS = [['tovisit', '待看'], ['visited', '看过'], ['review', '上会中']]
const STATUS_LABEL = Object.fromEntries([...STATUS, ['signed', '已签约'], ['rejected', '已否决']])
// One step back from anywhere, including out of a decision that was made in
// error — the server drops the decision record when a site leaves 已签约/已否决.
const PREV_STAGE = {
  visited: 'tovisit', review: 'visited',
  signed: 'review', rejected: 'review',
}
const FINAL = new Set(['signed', 'rejected'])
const decisionWhen = d => d?.at ? new Date(d.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
const REJECT = ['租金过高', '客流不足', '商圈不匹配', '竞品密集', '硬件不达标', '房东条件', '政策限制', '其他']

/**
 * Map layers. `rival` is whatever the project's own format is, so a pharmacy
 * project sees pharmacies picked out, not cafés — the label is rewritten from
 * the dataset's format list at load time.
 */
const LAYERS = [
  { key: 'brand', label: '参照品牌', color: '#0b7a5a', size: 5, on: true },
  { key: 'rival', label: '同类店', color: '#c47f2a', size: 3, on: true },
  { key: 'metro', label: '地铁', color: '#3f6fa8', size: 4, on: true },
  { key: 'mall', label: '商场', color: '#8f4fa8', size: 4.5, on: true },
  { key: 'food', label: '餐饮', color: '#9a9284', size: 2, on: false },
  { key: 'retail', label: '零售', color: '#a08a6a', size: 2, on: false },
  { key: 'office', label: '办公', color: '#7d8a94', size: 2.4, on: false },
  { key: 'residential', label: '住宅', color: '#7f9a84', size: 2, on: false },
]

// Seven F&B kinds replaced the single `food` kind; the map still wants one dot
// colour for "somewhere that sells food".
const FOOD_KINDS = ['restaurant', 'fastfood', 'cafe', 'teadrink', 'bakery', 'bar', 'dessert']

const state = {
  data: null, scores: {}, mode: 'yield', folder: '', revision: '',
  dataset: null, floorGrid: null, poiIndex: null, brandPoints: [], allPois: [],
  searchable: [], searchRoads: [],
  sort: { key: 'score', dir: -1 },
  view: 'map', filter: 'all', probe: null, selection: null,
  railSort: (() => { try { return localStorage.getItem('ss.railSort') || 'score' } catch { return 'score' } })(),
  inspectorOpen: (() => { try { return localStorage.getItem('ss.inspector') !== 'closed' } catch { return true } })(),
  railOpen: (() => { try { return localStorage.getItem('ss.rail') !== 'closed' } catch { return true } })(),
  pending: null, rendered: null, saving: false,
  // Set by 去定案 on a rail row; the inspector renders the 定案 group lit up
  // and scrolled into view for this site, then the flag is cleared.
  flashDecision: null, flashTimer: null,
}

const els = {
  app: $('app'), name: $('projectName'), sync: $('syncState'), bind: $('bindState'),
  stale: $('staleBanner'), rail: $('siteList'), count: $('siteCount'),
  inspector: $('inspector'), compareCount: $('compareCount'), canvas: $('map'),
  legend: $('mapLegend'), toast: $('toast'), camInfo: $('camInfo'), hint: $('mapHint'),
  views: { map: $('mapView'), ref: $('refView'), compare: $('compareView'),
    market: $('marketView'), log: $('logView') },
}

const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])
const fmt = (v, s = '') => (v === null || v === undefined || v === '' || Number.isNaN(v) ? '—' : `${v}${s}`)
const wan = v => (Number.isFinite(v) ? `${(v / 1e4).toFixed(1)} 万㎡` : '—')

let toastTimer
const toast = msg => {
  els.toast.textContent = msg
  els.toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800)
}
const setSync = (t, kind = '') => { els.sync.textContent = t; els.sync.dataset.state = kind }

const sites = () => state.data?.sites || []
/** Whichever model the server said is driving the scores. */
const rankModel = () => (state.mode === 'reference' ? state.data?.referenceModel : state.data?.districtModel) || null
const refModel = rankModel
const selectedSite = () => sites().find(s => s.id === state.selection) || null
const scoreOf = id => state.scores?.[id] || null

// ── theme ────────────────────────────────────────────────
const theme = () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  return dark
    ? { bg: '#0f1416', grid: 'rgba(255,255,255,.05)',
        area: { water: '#16303f', park: '#17301f', green: '#1a2c1d', residential: '#191d1f',
                commercial: '#211d24', industrial: '#1d1f22', education: '#1e2119' },
        road: { expy: { color: '#c99a4a', casing: '#0f1416', width: 4.2 },
                major: { color: '#4c5559', casing: '#0f1416', width: 3.0 },
                minor: { color: '#3e4649', casing: '#0f1416', width: 2.1, minor: true },
                link: { color: '#8a7440', casing: '#0f1416', width: 1.8, minor: true },
                local: { color: '#333a3d', casing: '#0f1416', width: 1.2, minor: true } },
        roadOrder: ['local', 'minor', 'link', 'major', 'expy'],
        cat: { food: '#e08a45', shop: '#d98a34', transit: '#5a94e0', health: '#e06a6a',
               edu: '#8b9ae8', park: '#5cb672', stay: '#ab86d6', work: '#8d959c', place: '#9aa2a8' },
        labelText: '#e8ecee', labelHalo: 'rgba(15,20,22,.92)', roadLabel: '#b6bfc4',
        knownTop: '#4a555d', knownWall: '#2a3237', guessTop: '#333b40', guessWall: '#212729',
        tallTop: '#7b8d97', tallWall: '#47555e', tallEdge: 'rgba(180,215,235,.5)', roofEdge: 'rgba(0,0,0,.35)',
        shadow: 'rgba(0,0,0,.55)', labelBg: 'rgba(16,19,20,.88)', labelText: '#e4e9eb',
        markerRing: 'rgba(255,255,255,.55)', markerRingOn: '#fff', poiOrder: LAYERS }
    : { bg: '#f2efe8', grid: 'rgba(0,0,0,.055)',
        area: { water: '#a5cbe4', park: '#c2e2b6', green: '#d6e9c9', residential: '#eeeae2',
                commercial: '#f6e5d5', industrial: '#e5e1e6', education: '#e8ead9' },
        road: { expy: { color: '#f7c877', casing: '#e0a94e', width: 4.2 },
                major: { color: '#ffffff', casing: '#d9d5cc', width: 3.0 },
                minor: { color: '#ffffff', casing: '#dedad1', width: 2.1, minor: true },
                link: { color: '#fbe0b0', casing: '#e3c98f', width: 1.8, minor: true },
                local: { color: '#fbfaf7', casing: '#e2ded5', width: 1.2, minor: true } },
        roadOrder: ['local', 'minor', 'link', 'major', 'expy'],
        cat: { food: '#e07b2e', shop: '#cf7a20', transit: '#3b7cd3', health: '#dc4b4b',
               edu: '#6b7fd6', park: '#3f9e57', stay: '#8f5fc4', work: '#7b848c', place: '#6f777d' },
        labelText: '#23282b', labelHalo: 'rgba(255,255,255,.95)', roadLabel: '#5d666c',
        // Roof lighter than wall gives the extrusion its shape; the earlier values
        // were within a few percent of the ground and the city read as empty.
        knownTop: '#f2f1ec', knownWall: '#9aa3a8', guessTop: '#e2e2dc', guessWall: '#b0b5b4',
        tallTop: '#ffffff', tallWall: '#78858d', tallEdge: 'rgba(40,60,75,.45)', roofEdge: 'rgba(90,100,105,.35)',
        shadow: 'rgba(0,0,0,.2)', labelBg: 'rgba(255,255,255,.94)', labelText: '#1c2124',
        markerRing: 'rgba(255,255,255,.9)', markerRingOn: '#fff', poiOrder: LAYERS }
}

// ── map ──────────────────────────────────────────────────
const map = new window.Map3D(els.canvas)
map.layers = Object.fromEntries(LAYERS.map(l => [l.key, l.on]))
let mapReady = false

const tierColor = t => (t === 'visit' ? '#2f7d5f' : t === 'maybe' ? '#9a6b1e' : t === 'no' ? '#a8453c' : '#6b7275')

// One colour for everything simulated, used on the map and in the 铺源 tab.
const SIM_COLOR = '#b8862c'
const SIM_RING = 'rgba(184,134,44,.65)'

// A unit is labelled by its rent per ㎡ per day — the number the 铺源 layer
// prints — so it reads the same before and after it is taken into the list.
const unitLabel = s => (Number.isFinite(s.rent) && s.area ? `${(s.rent / s.area / 30).toFixed(1)}` : '铺')
const listingIdOf = s => (String(s?.source || '').match(/lst-\d+/) || [])[0] || ''

function rebuildMarkers() {
  // An adopted listing is still a listing. Drawing it in the score colours made
  // the same shop change colour and meaning the moment it entered the list, and
  // made it indistinguishable from a candidate location.
  const list = sites().filter(s => Number.isFinite(s.lng)).map(s => {
    const sc = scoreOf(s.id)
    const [x, y] = map.toLocalAbs(s.lng, s.lat)
    const isUnit = s.kind === 'unit'
    return { x, y, id: s.id, kind: 'site', unit: isUnit,
      label: isUnit ? unitLabel(s) : (sc?.score ?? '?'),
      color: isUnit ? SIM_COLOR : tierColor(sc?.tier),
      selected: s.id === state.selection, tall: false }
  })
  if (state.probe) {
    const [x, y] = map.toLocalAbs(state.probe.point.lng, state.probe.point.lat)
    list.push({ x, y, id: '__probe__', kind: 'probe', label: state.probe.score ?? '?',
      color: tierColor(state.probe.tier), selected: state.selection === '__probe__', tall: true })
  }
  // Simulated listings. A layer shows what is in view, not what happens to be
  // near a saved site — filtering to sites meant toggling it on changed nothing
  // visible unless you were already looking at one. The 铺源 table stays
  // site-relative; the map does not.
  if (state.showListings && state.market) {
    // A listing already taken into the list is drawn above as a unit; drawing it
    // again from the layer put two markers on one shop.
    const adopted = new Set(sites()
      .map(x => (String(x.source || '').match(/lst-\d+/) || [])[0]).filter(Boolean))
    const seen = []
    for (const l of state.market.listings) {
      if (l.status !== '在租' || adopted.has(l.id)) continue
      const [x, y] = map.toLocalAbs(l.lng, l.lat)
      // Thin by screen distance so a dense street reads as a cluster rather
      // than a solid bar of overlapping labels.
      const near = map.view ? Math.max(map.view.dist / 90, 60) : 120
      if (seen.some(s => Math.hypot(s.x - x, s.y - y) < near)) continue
      seen.push({ x, y })
      list.push({ x, y, id: l.id, kind: 'listing', unit: true, label: `${l.rentPerSqmDay}`,
        color: SIM_COLOR, selected: state.selection === `__listing__${l.id}`, tall: false })
      if (seen.length >= 400) break
    }
  }
  map.setMarkers(list)

  const focus = state.selection === '__probe__' ? state.probe?.point : selectedSite()
  // The rings take the colour of what they surround: a shop for rent stays
  // amber when opened, a location stays green.
  map.setRings(focus && Number.isFinite(focus.lng)
    ? [{ ...(([x, y]) => ({ x, y }))(map.toLocalAbs(focus.lng, focus.lat)),
        radii: [300, 500], color: focus.kind === 'unit' ? SIM_RING : 'rgba(47,125,95,.6)' }]
    : [])
}

function drawMap() {
  if (!mapReady) return
  map.draw(theme())
  const v = map.view
  els.camInfo.textContent = `视距 ${(v.dist / 1000).toFixed(1)} km · 俯仰 ${Math.round((v.pitch * 180) / Math.PI)}° · 方位 ${Math.round(((v.bearing * 180) / Math.PI + 360) % 360)}°`
}

let sizeW = 0, sizeH = 0
setInterval(() => {
  if (state.view !== 'map' || !mapReady) return
  const r = els.canvas.getBoundingClientRect()
  const w = Math.round(r.width), h = Math.round(r.height)
  if (w < 2 || h < 2 || (w === sizeW && h === sizeH)) return
  sizeW = w; sizeH = h
  map.resize()
  drawMap()
}, 200)

// ── probing: the whole point of the map ──────────────────
function probeCtx() {
  return { floorGrid: state.floorGrid, brandPoints: state.brandPoints, index: state.poiIndex,
    basemapIndex: state.basemapIndex, availableKinds: state.availableKinds,
    format: state.data?.project?.format, rivals: state.data?.project?.rivals }
}

function analyse(point) {
  const model = rankModel()
  if (!model?.ready) return { ready: false, mode: state.mode, point, metrics: [], flags: [], score: null, tier: 'unknown', features: {} }
  return { ...rankAgainstReference(point, state.allPois, model, probeCtx()), mode: state.mode, point }
}

function probeAt(lng, lat) {
  const t0 = performance.now()
  state.probe = analyse({ lng, lat })
  state.probe.ms = Math.round(performance.now() - t0)
  state.selection = '__probe__'
  rebuildMarkers(); drawMap(); renderInspector(); renderRail()
}

function setInspector(open) {
  state.inspectorOpen = open
  try { localStorage.setItem('ss.inspector', open ? 'open' : 'closed') } catch {}
  document.querySelector('.workspace').classList.toggle('inspector-collapsed', !open)
  const btn = $('toggleInspector')
  // Only the tooltip changes; the glyph flips in CSS. Rewriting the label made
  // the button change width and shuffle everything beside it on every click.
  if (btn) btn.title = open ? '折叠右侧详情，地图占满' : '展开右侧详情'
  // The map watcher picks the new width up on its next tick; nudge it now.
  if (state.view === 'map') { map.resize(); drawMap() }
}

function setRail(open) {
  state.railOpen = open
  try { localStorage.setItem('ss.rail', open ? 'open' : 'closed') } catch {}
  document.querySelector('.workspace').classList.toggle('rail-collapsed', !open)
  const btn = $('toggleRail')
  if (btn) btn.title = open ? '折叠左侧点位列表' : '展开左侧点位列表'
  if (state.view === 'map') { map.resize(); drawMap() }
}

// ── map interaction ──────────────────────────────────────
let drag = null
els.canvas.addEventListener('contextmenu', e => e.preventDefault())
els.canvas.addEventListener('mousedown', e => {
  drag = { x: e.clientX, y: e.clientY, moved: false,
    rotate: e.button === 2 || e.shiftKey,
    cx: map.view.cx, cy: map.view.cy, bearing: map.view.bearing, pitch: map.view.pitch }
  map.quality = 'fast'
})
window.addEventListener('mouseup', e => {
  if (!drag) return
  const wasDrag = drag.moved
  const rotate = drag.rotate
  drag = null
  map.quality = 'full'
  drawMap()
  if (wasDrag || rotate) return
  const r = els.canvas.getBoundingClientRect()
  const px = e.clientX - r.left, py = e.clientY - r.top
  if (px < 0 || py < 0 || px > r.width || py > r.height) return
  const marker = map.hitMarker(px, py)
  if (marker && marker.kind === 'site') { selectSite(marker.id); return }   // already in view
  if (marker && marker.kind === 'probe') return
  // A listing pin used to fall through to probeAt, so clicking it analysed the
  // ground under it instead of showing the shop that is for rent there.
  if (marker && marker.kind === 'listing') {
    const l = state.market?.listings.find(x => x.id === marker.id)
    if (l) { state.selection = `__listing__${l.id}`; state.probe = null; renderAll(); rebuildMarkers(); drawMap() }
    return
  }
  const ll = map.unproject(px, py)
  if (ll) probeAt(Number(ll[0].toFixed(6)), Number(ll[1].toFixed(6)))
})
window.addEventListener('mousemove', e => {
  if (!drag) return
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
  if (drag.rotate) {
    map.view.bearing = drag.bearing + dx * 0.006
    map.view.pitch = Math.max(0.26, Math.min(1.48, drag.pitch + dy * 0.004))
  } else {
    // pan along the ground plane, in the camera's own frame
    const scale = map.view.dist / 900
    const b = map.view.bearing
    const ex = -dx * scale, ny = dy * scale / Math.max(Math.sin(map.view.pitch), 0.3)
    map.view.cx = drag.cx + (ex * Math.cos(b) + ny * Math.sin(b)) / (111320 * Math.cos((map.view.cy * Math.PI) / 180))
    map.view.cy = drag.cy + (-ex * Math.sin(b) + ny * Math.cos(b)) / 110540
  }
  drawMap()
})
els.canvas.addEventListener('wheel', e => {
  e.preventDefault()
  map.view.dist = Math.max(220, Math.min(14000, map.view.dist * Math.exp(e.deltaY * 0.0014)))
  drawMap()
}, { passive: false })

$('toggleInspector').onclick = () => setInspector(!state.inspectorOpen)
$('toggleRail').onclick = () => setRail(!state.railOpen)
$('railSort').onclick = () => {
  const order = ['score', 'name', 'added']
  state.railSort = order[(order.indexOf(state.railSort) + 1) % order.length]
  try { localStorage.setItem('ss.railSort', state.railSort) } catch {}
  renderRail()
}
document.getElementById('mapTools').addEventListener('click', e => {
  const btn = e.target.closest('[data-cam]')
  if (!btn) return
  if (btn.dataset.cam === 'top') { map.view.pitch = 1.42 }
  else if (btn.dataset.cam === 'tilt') { map.view.pitch = 0.38 }
  else { fitMap() }
  drawMap()
})

function fitMap() {
  const b = state.dataset?.bbox
  const pts = sites().filter(s => Number.isFinite(s.lng))
  if (pts.length) {
    const lngs = pts.map(s => s.lng), lats = pts.map(s => s.lat)
    map.view.cx = (Math.min(...lngs) + Math.max(...lngs)) / 2
    map.view.cy = (Math.min(...lats) + Math.max(...lats)) / 2
    const spanM = Math.max(
      (Math.max(...lngs) - Math.min(...lngs)) * 111320 * Math.cos((map.view.cy * Math.PI) / 180),
      (Math.max(...lats) - Math.min(...lats)) * 110540, 900)
    map.view.dist = Math.min(9000, spanM * 1.6)
  } else if (state.dataset?.focus) {
    map.view.cx = state.dataset.focus.lng
    map.view.cy = state.dataset.focus.lat
    map.view.dist = 1500
  } else if (b) {
    map.view.cx = (b.minLng + b.maxLng) / 2
    map.view.cy = (b.minLat + b.maxLat) / 2
    map.view.dist = 5000
  }
  map.view.pitch = 0.42
  map.view.bearing = 0.75
}

// ── dataset ──────────────────────────────────────────────
async function loadDataset(name) {
  const doc = await fetch(`/api/site-selection/dataset?name=${encodeURIComponent(name)}`).then(r => r.json())
  state.dataset = doc
  state.allPois = doc.pois
  state.floorGrid = doc.floorArea ? indexFloorGrid(doc.floorArea) : null
  state.poiIndex = indexPois(doc.pois)
  state.basemapIndex = doc.basemap ? indexBasemap(doc.basemap) : null
  state.availableKinds = new Set(doc.pois.map(p => p.kind))
  state.rivalKinds = rivalKindsOf(state.data?.project?.format)
  const fmt = formatOf(state.data?.project?.format)
  const rivalLayer = LAYERS.find(l => l.key === 'rival')
  if (rivalLayer) rivalLayer.label = fmt ? `其他${fmt.label}店` : '同类店'
  // Fetched separately and never mixed into `allPois`: the simulated commercial
  // layer must have no path into anything that computes a score.
  state.market = null
  if (doc.hasMarket) {
    try {
      state.market = await fetch(`/api/site-selection/market?name=${encodeURIComponent(name)}`).then(r => r.json())
    } catch { state.market = null }
  }
  const marketTab = $('marketTab')
  if (marketTab) marketTab.hidden = !state.market
  const listingsBtn = $('toggleListings')
  if (listingsBtn) listingsBtn.hidden = !state.market
  const brand = String(state.data?.project?.referenceBrand || '').toLowerCase()
  state.brandPoints = brand
    ? doc.pois.filter(p => p.kind === 'cafe' && `${p.brand || ''}${p.name || ''}`.toLowerCase().includes(brand))
    : []
  // Open on the skyline: the centroid of the tallest buildings, not the middle of
  // whatever box the data was fetched in.
  const tall = (doc.buildings || []).filter(b => b.h > 90).slice(0, 40)
  if (tall.length) {
    let lng = 0, lat = 0, n = 0
    for (const b of tall) {
      const w = b.h * b.h            // height-weighted: the skyline should frame the shot
      lng += b.r[0][0] * w; lat += b.r[0][1] * w; n += w
    }
    state.dataset.focus = { lng: lng / n, lat: lat / n }
  } else if (doc.floorArea?.coverage) {
    const c = doc.floorArea.coverage
    state.dataset.focus = { lng: (c.minLng + c.maxLng) / 2, lat: (c.minLat + c.maxLat) / 2 }
  }
  map.setAnchor(doc.bbox ? (doc.bbox.minLng + doc.bbox.maxLng) / 2 : 116.46,
    doc.bbox ? (doc.bbox.minLat + doc.bbox.maxLat) / 2 : 39.91)
  map.setBasemap(doc.basemap?.areas || [], doc.basemap?.roads || [])
  // Everything with a name becomes a map label and a search target.
  const named = [...doc.pois.filter(p => p.name && p.cat), ...(doc.places || [])]
  map.setLabels(named.map(p => {
    const [x, y] = map.toLocalAbs(p.lng, p.lat)
    return { x, y, name: p.name, cat: p.cat, pri: p.pri ?? 4 }
  }))
  state.searchable = named
  state.searchRoads = (doc.basemap?.roads || []).filter(r => r.n).map(r => {
    const mid = r.p[Math.floor(r.p.length / 2)]
    return { name: r.n, lng: mid[0], lat: mid[1], cat: 'road', pri: 2 }
  })
  map.setBuildings(doc.buildings || [])
  const brandSet = new Set(state.brandPoints)
  const rivalKinds = new Set(state.rivalKinds || [])
  map.setPois(doc.pois.map(p => {
    const [x, y] = map.toLocalAbs(p.lng, p.lat)
    const layer = brandSet.has(p) ? 'brand'
      : rivalKinds.has(p.kind) ? 'rival'
        : p.kind === 'metro_exit' ? 'metro'
          : ['mall', 'office', 'residential'].includes(p.kind) ? p.kind
            : FOOD_KINDS.includes(p.kind) ? 'food'
              : RETAIL_LAYER_KINDS.has(p.kind) ? 'retail' : p.kind
    return { x, y, layer }
  }))
  mapReady = true
  fitMap()
  map.resize()
  drawMap()
}


// ══ ANALYSIS RENDERING ═══════════════════════════════════
function tierBadge(tier, score) {
  return `<div class="score-row"><span class="score-main ${esc(tier)}">${score ?? '—'}</span>
    <span class="score-tier ${esc(tier)}">${TIER_LABEL[tier] || ''}</span></div>`
}

/** Reference mode: percentile against where the brand already is. */
function pctRow(m) {
  const val = m.scale > 1 ? (m.value / m.scale).toFixed(1) : Math.round(m.value)
  const med = m.scale > 1 ? (m.median / m.scale).toFixed(1) : Math.round(m.median)
  return `<div class="pct-row" title="${esc(m.hint || '')}">
    <div class="pct-head"><span>${esc(m.label)}</span><b>${val} ${esc(m.unit)}</b></div>
    <div class="pct-bar"><i class="${m.verdict}" style="width:${m.percentile}%"></i>
      <u style="left:50%" title="基线中位数"></u></div>
    <div class="pct-foot"><span>第 ${m.percentile} 百分位</span><span>基线中位 ${med} ${esc(m.unit)}</span></div>
  </div>`
}

/** Who is around, as a mix. Never scored — see customerMix() for why. */
function mixBlock(mix) {
  if (!mix) return ''
  const bar = mix.top.map(t => t.share > 0
    ? `<i class="seg-${esc(t.key)}" style="width:${t.share}%" title="${esc(t.label)} ${t.share}%"></i>` : '').join('')
  return `<div class="mix">
    <div class="mix-head"><span>客群结构</span><b>以${esc(mix.dominant.label)}为主 ${mix.dominant.share}%</b></div>
    <div class="mix-bar">${bar}</div>
    <div class="mix-legend">${mix.top.map(t =>
      `<span title="${esc(t.hint)}"><i class="seg-${esc(t.key)}"></i>${esc(t.label)} ${t.share}%</span>`).join('')}</div>
    ${mix.dayNight === null ? '' : `<div class="mix-note">日夜人口比 ${mix.dayNight}%——${
      mix.dayNight >= 65 ? '写字楼盘，工作日午市为主'
      : mix.dayNight <= 30 ? '居住盘，晚间和周末为主'
      : '日夜均衡'}</div>`}
  </div>`
}

/**
 * Listings near a saved location, shown without being asked for.
 *
 * They were only reachable by running a command or clicking a map pin, so a
 * location looked like a bare score when the dataset already knew what was for
 * rent there. Evaluating a position and seeing what you could actually take
 * belong on the same screen.
 */
function nearbyListingsBlock(site) {
  if (!state.market || site.kind === 'unit' || !Number.isFinite(site.lng)) return ''
  const adopted = new Set((sites() || [])
    .map(x => (String(x.source || '').match(/lst-\d+/) || [])[0]).filter(Boolean))
  const near = state.market.listings
    .filter(l => l.status === '在租')
    .map(l => ({ l, d: Math.round(haversine(site, l)) }))
    .filter(x => x.d <= 400)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
  if (!near.length) return `<div class="group"><h3>附近在租铺源</h3>
    <p class="hint">400m 内没有在租铺源</p></div>`
  const money = v => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))
  return `<div class="group"><h3>附近在租铺源 <small class="dim">400m 内 ${near.length} 家</small></h3>
    <div class="near-list">${near.map(({ l, d }) => {
      const gate = [l.hasFlue, l.hasWater, l.canLicense].filter(Boolean).length
      const has = adopted.has(l.id)
      return `<div class="near-row" data-pick-listing="${esc(l.id)}">
        <span class="near-main"><b>${esc(l.address)}</b>
          <small>${l.areaSqm}㎡ · ${money(l.rentPerMonth)}/月 · ${l.rentPerSqmDay} 元/㎡/天 · ${d}m</small></span>
        <span class="near-side">
          <i class="${gate === 3 ? 'gate-ok' : 'gate-bad'}">${gate === 3 ? '条件齐' : `缺 ${3 - gate} 项`}</i>
          ${has ? '<em>已收</em>' : `<button class="button small" type="button" data-listing="${esc(l.id)}">收进</button>`}
        </span>
      </div>`
    }).join('')}</div></div>`
}

/** What no dataset can answer — listed, not quietly dropped. */
function fieldBlock(field) {
  if (!field) return ''
  // When the list empties, say so. Rendering nothing made the best possible
  // outcome look identical to a bug — and going from nine open questions to
  // none is exactly what buying the铺源 data buys you.
  if (!field.gaps.length) {
    return `<div class="gaps done">
      <div class="gaps-head"><span>现场字段已齐</span><b>已填 100%</b></div>
    </div>`
  }
  return `<div class="gaps">
    <div class="gaps-head"><span>待补字段</span><b>已填 ${field.coverage}%</b></div>
    <ul>${field.gaps.map(g => `<li><b>${esc(g.label)}</b>${esc(g.ask || '')}</li>`).join('')}</ul>
  </div>`
}

/** Reference mode: percentile against where the brand already is. */
/**
 * Why this verdict — the sentence that belongs under the badge.
 *
 * That slot used to hold the scoring methodology ("三项先各自算再平均…"), which
 * answers a question nobody asks twice and never says why THIS pitch got THIS
 *答案. Methodology lives in 参照系; the verdict says what decided it.
 */
function verdictReason(r) {
  if (r.exclusions?.length) {
    return `<b class="why-no">不建议</b>：${esc(r.exclusions.map(x => x.text).join('；'))}`
  }
  const bad = (r.flags || []).find(f => f.level === 'bad')
  if (bad) return `<b class="why-no">不建议</b>：${esc(bad.text)}`

  const live = (r.groups || []).filter(g => g.score !== null)
  if (!live.length) return '数据不足，无法判断。'
  const best = [...live].sort((a, b) => b.score - a.score)[0]
  const worst = [...live].sort((a, b) => a.score - b.score)[0]
  const warn = (r.flags || []).filter(f => f.level === 'warn')
  const tail = warn.length ? `　${esc(warn[0].text)}` : ''
  const pct = g => `${esc(g.label)}第 ${g.score} 百分位`

  if (r.tier === 'visit') {
    return `<b class="why-yes">值得去看</b>：${pct(best)}` + (worst.score < 40 ? `，短板是${pct(worst)}` : '') + tail
  }
  if (r.tier === 'maybe') return `<b class="why-maybe">待定</b>：${pct(best)}，但${pct(worst)}${tail}`
  return `<b class="why-no">不建议</b>：${pct(worst)}${tail}`
}

function referenceBlock(r) {
  const groups = (r.groups || []).filter(g => g.n).map(g => `
    <div class="grp">
      <div class="grp-head" title="${esc(g.hint || '')}">
        <span>${esc(g.label)}</span><b class="${g.score >= 70 ? 'good' : g.score >= 40 ? 'fair' : 'poor'}">${g.score}</b>
      </div>
      <div class="pcts">${g.metrics.map(pctRow).join('')}</div>
    </div>`).join('')
  const extra = r.metrics.filter(m => !m.group)
  const flags = r.flags.map(f => `<div class="alert ${f.level === 'bad' ? 'bad' : ''}">${esc(f.text)}</div>`).join('')
  const missing = r.missing?.length
    ? `<div class="alert dim">未计分（基线数据不足）：${esc(r.missing.map(m => m.label).join('、'))}</div>` : ''
  return `<div class="score-block">
    ${tierBadge(r.tier, r.score)}
    <div class="verdict-why">${verdictReason(r)}</div>
    ${groups}
    ${extra.length ? `<div class="grp"><div class="grp-head"><span>竞争（不计入总分）</span></div>
      <div class="pcts">${extra.map(pctRow).join('')}</div></div>` : ''}
  </div>${missing}${flags}${mixBlock(r.customerMix)}${fieldBlock(r.field)}`
}

const analysisBlock = r => referenceBlock(r)

function contextLines(f) {
  const street = [f.roadName && esc(f.roadName), f.roadClassLabel && esc(f.roadClassLabel),
    Number.isFinite(f.roadDist) ? `退线 ${f.roadDist} m` : ''].filter(Boolean).join(' · ')
  return `<div class="ins-sub">
    ${esc(f.districtType || '')}${street ? `　临街：${street}` : ''}<br>
    最近地铁 ${fmt(f.metroDist, ' m')}${f.metroName ? `（${esc(f.metroName)}）` : ''}　300m 公交 ${fmt(f.busStop300)} 站　150m 过街 ${fmt(f.crossing150)} 处<br>
    500m 建筑面积 ${wan(f.floorArea500)}　500m 餐饮 ${fmt(f.food500)} 家　500m 咖啡 ${fmt(f.cafe500)} 家<br>
    最近商场 ${fmt(f.mallDist, ' m')}${f.mallName ? `（${esc(f.mallName)}）` : ''}${Number.isFinite(f.brandDist) ? `　最近参照门店 ${f.brandDist} m` : ''}
  </div>`
}

// ══ VIEWS ════════════════════════════════════════════════
function renderTop() {
  const p = state.data.project
  const fmt = formatOf(p.format)
  els.name.textContent = [p.city, fmt?.label, p.referenceBrand ? `参照 ${p.referenceBrand}` : '']
    .filter(Boolean).join(' · ')
  els.name.title = `${p.name}　${state.folder}`
}

/**
 * The one line under a site's name.
 *
 * It used to print `商圈 · — · 租金未填` for every unvisited site: two of the
 * three slots were placeholders, so the row was mostly punctuation. Show only
 * what is actually known, and when nothing is, say what the site is waiting for
 * instead of showing dashes.
 */
function railSub(site, sc) {
  const bits = []
  if (sc?.features?.districtType) bits.push(esc(sc.features.districtType))
  if (Number.isFinite(site.area)) bits.push(`${site.area}㎡`)
  if (Number.isFinite(site.rent)) bits.push(`${Math.round(site.rent / 1000)}k/月`)
  // 已否决 carries its reason into the row: the list is where you look for
  // "why did we drop that one" before opening anything.
  if (site.status === 'rejected' && site.decision) {
    const why = [...(site.decision.reasons || []), site.decision.note].filter(Boolean)[0]
    if (why) bits.unshift(esc(why))
  }
  const text = bits.length ? bits.join(' · ') : '待补铺面资料'
  // 待看 is where every site starts, so it is the one stage the row says
  // nothing about; the pill is for stages the site has been moved into.
  const pill = site.status !== 'tovisit' && STATUS_LABEL[site.status]
    ? `<i class="st st-${esc(site.status)}">${esc(STATUS_LABEL[site.status])}</i>` : ''
  return pill + text
}

function renderRail() {
  const all = sites()
  els.count.textContent = all.length
  // Stages, not a mix of score and status. The old row had 值得看 (a score
  // threshold) sitting beside 跟进中 and 已定案 (statuses), so it neither
  // filtered consistently nor showed where a site was in the process.
  const visible = all.filter(s => {
    if (state.filter === 'tovisit') return s.status === 'tovisit'
    if (state.filter === 'visited') return s.status === 'visited'
    if (state.filter === 'review') return s.status === 'review'
    if (state.filter === 'closed') return FINAL.has(s.status)
    return true
  })
  const RAIL_SORTS = {
    score: [(a, b) => (scoreOf(b.id)?.score ?? -1) - (scoreOf(a.id)?.score ?? -1), '分数 ↓'],
    name: [(a, b) => String(a.name).localeCompare(String(b.name), 'zh'), '名称'],
    added: [(a, b) => String(b.createdAt).localeCompare(String(a.createdAt)), '最近加入'],
  }
  const sorter = RAIL_SORTS[state.railSort] || RAIL_SORTS.score
  visible.sort(sorter[0])
  const sortBtn = $('railSort')
  if (sortBtn) sortBtn.textContent = sorter[1]

  const probeRow = state.probe ? `<div class="site-row probe ${state.selection === '__probe__' ? 'selected' : ''}" data-site="__probe__">
      <span class="badge ${esc(state.probe.tier)}">${state.probe.score ?? '?'}</span>
      <span class="site-copy"><b>刚点的位置</b><small>未保存 · ${esc(state.probe.features.districtType || '')}</small></span>
    </div>` : ''
  /**
   * The next step for a site, as a one-click action on the row itself.
   *
   * The stages existed but nothing moved a site between them: you had to open
   * the inspector and find a button. A filter row that shows stages while
   * nothing advances them is a process on paper only.
   */
  const NEXT_STAGE = {
    tovisit: ['visited', '看过了'],
    visited: ['review', '上会'],
    // 上会 is not the end of the road: the last step is signing or rejecting,
    // and that needs a reason, so it opens the site rather than flipping a flag.
    review: ['__decide__', '去定案'],
  }

  const row = (s, isUnit) => {
    const sc = scoreOf(s.id)
    // No risk dot here: it read as an unread badge that would not clear. The
    // inspector lists the same risks in full when the site is opened.
    return `<div class="site-row st-${esc(s.status)} ${isUnit ? 'is-unit' : ''} ${s.id === state.selection ? 'selected' : ''}"
      data-site="${esc(s.id)}" title="${esc(s.name)} · ${esc(STATUS_LABEL[s.status] || '')}">
      ${isUnit
        ? `<span class="badge unit" title="租金 元/㎡/天">${esc(unitLabel(s))}</span>`
        : `<span class="badge ${esc(sc?.tier || '')}">${sc?.score ?? '?'}</span>`}
      <span class="site-copy"><b>${esc(s.name)}</b>
        <small>${railSub(s, sc)}</small></span>
      <span class="stage-ctl">
        ${PREV_STAGE[s.status] ? `<button class="stage-back" type="button"
          data-back="${esc(s.id)}" data-to="${PREV_STAGE[s.status]}"
          title="${FINAL.has(s.status) ? '撤回定案，' : ''}退回「${esc(STATUS_LABEL[PREV_STAGE[s.status]] || '')}」">‹</button>` : ''}
        ${NEXT_STAGE[s.status] ? `<button class="stage-next" type="button"
          data-advance="${esc(s.id)}" data-to="${NEXT_STAGE[s.status][0]}"
          title="${NEXT_STAGE[s.status][0] === '__decide__' ? '打开这个点位去签约或否决'
            : `标记为「${esc(STATUS_LABEL[NEXT_STAGE[s.status][0]] || '')}」`}"
          >${esc(NEXT_STAGE[s.status][1])}</button>` : ''}
      </span>
    </div>`
  }

  // Units render beneath the location they belong to. A unit whose parent is
  // filtered out still has to appear, or it silently vanishes from the list.
  const shown = new Set(visible.map(s => s.id))
  const unitsOf = new Map()
  for (const s of all) {
    if (s.kind !== 'unit') continue
    const key = s.parentId && shown.has(s.parentId) ? s.parentId : '__loose__'
    if (!unitsOf.has(key)) unitsOf.set(key, [])
    unitsOf.get(key).push(s)
  }
  const body = visible.filter(s => s.kind !== 'unit').map(s => {
    const kids = (unitsOf.get(s.id) || []).filter(u => shown.has(u.id))
    return row(s, false) + (kids.length
      ? `<div class="unit-group">${kids.map(u => row(u, true)).join('')}</div>` : '')
  }).join('')
  const loose = (unitsOf.get('__loose__') || []).filter(u => shown.has(u.id))
  els.rail.innerHTML = probeRow + ((body + loose.map(u => row(u, true)).join(''))
    || (all.length ? '<div class="empty">这个筛选下没有点位</div>'
    : '<div class="empty">还没有点位<br><br>点地图任意位置开始</div>'))
}

/** A listing picked off the map: what it is, and the one thing to do with it. */
function renderListingInspector(l) {
  const money = v => (v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : String(v))
  const gate = [['排烟', l.hasFlue], ['上下水', l.hasWater], ['可办证', l.canLicense], ['燃气', l.hasGas]]
  const floor = l.floor === 1 ? '首层' : l.floor === -1 ? '地下一层' : `${l.floor} 层`
  els.inspector.innerHTML = `<div class="ins">
    <div class="ins-kicker">在租铺源 · ${esc(l.id)}</div>
    <h2 class="ins-name-static">${esc(l.address)}</h2>
    <div class="ins-sub">${l.areaSqm} ㎡　${esc(floor)}${l.inMall ? `　${esc(l.mallTier || '')}商场内` : ''}
      ${l.frontageM ? `　面宽 ${l.frontageM}m` : ''}　层高 ${l.ceilingM}m　电 ${l.powerKw}kW</div>
    <div class="group">
      <div class="grid2">
        <div class="stat"><span>月租</span><b>${money(l.rentPerMonth)}<small> 元</small></b></div>
        <div class="stat"><span>单价</span><b>${l.rentPerSqmDay}<small> 元/㎡/天</small></b></div>
        <div class="stat"><span>转让费</span><b>${l.transferFee ? money(l.transferFee) : '无'}</b></div>
        <div class="stat"><span>免租期</span><b>${l.freeRentDays}<small> 天</small></b></div>
      </div>
      <p class="hint">前身 ${esc(l.formerUse)}　已空置 ${l.vacantMonths} 个月　租期 ${l.leaseYears} 年年递增 ${l.increaseRatePct}%　物业费 ${l.propertyFeePerSqm} 元/㎡/月</p>
    </div>
    <div class="group"><h3>硬性条件</h3>
      <div class="gate-row">${gate.map(([k, v]) =>
        `<span class="${v ? 'gate-ok' : 'gate-bad'}">${v ? '✓' : '✗'} ${esc(k)}</span>`).join('')}</div>
    </div>
    <div class="group">
      <button class="button primary" id="adoptListing" type="button" style="width:100%"
        data-listing="${esc(l.id)}">收进点位清单</button>
    </div>
  </div>`
}

function renderInspector() {
  if (String(state.selection).startsWith('__listing__')) {
    const id = String(state.selection).slice('__listing__'.length)
    const l = state.market?.listings.find(x => x.id === id)
    if (l) return renderListingInspector(l)
  }
  if (state.selection === '__probe__' && state.probe) return renderProbeInspector()
  const site = selectedSite()
  if (!site) {
    state.rendered = null
    els.inspector.innerHTML = '<div class="inspector-empty">点地图任意位置<br>或在左侧选一个点位</div>'
    return
  }
  renderSiteInspector(site)
}

function renderProbeInspector() {
  const r = state.probe
  state.rendered = null
  els.inspector.innerHTML = `<div class="ins">
    <div class="ins-kicker">刚点的位置 · 未保存 <span class="ms">${r.ms}ms</span></div>
    <div class="ins-name-static">${r.point.lng.toFixed(5)}, ${r.point.lat.toFixed(5)}</div>
    ${contextLines(r.features)}
    ${analysisBlock(r)}
    <div class="group">
      <button class="button primary" id="saveProbe" type="button" style="width:100%">保存为候选点位</button>
    </div>
    <div class="group"><h3>交给 DSH</h3>
      <label class="field"><span>问点什么</span><textarea id="askInput" placeholder="例如：附近有没有在建的写字楼？"></textarea></label>
      <button class="button" data-ask="research" type="button" style="width:100%;margin-top:6px">带上这个点位问 DSH →</button>
    </div>
  </div>`
}

/**
 * The head of an adopted listing: still a shop for rent, still amber.
 *
 * Once a listing was taken into the list it opened as「已保存点位」with a
 * score, which is the look of a location — the thing it sits inside, not the
 * thing it is. Keep the listing's own identity: its id, the location it hangs
 * under, and the rent figures the 铺源 layer shows.
 */
function unitHead(site) {
  const lid = listingIdOf(site)
  const parent = site.parentId ? sites().find(x => x.id === site.parentId) : null
  const money = v => (v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : String(v))
  const perDay = Number.isFinite(site.rent) && site.area ? (site.rent / site.area / 30).toFixed(2) : null
  const floor = site.floor === 1 ? '首层' : site.floor === -1 ? '地下一层' : Number.isFinite(site.floor) ? `${site.floor} 层` : ''
  return `<div class="ins-kicker unit"><i class="sim-dot"></i>已收进的铺源${lid ? ` · ${esc(lid)}` : ''}${parent
      ? ` · <button type="button" class="linklike" data-open-site="${esc(parent.id)}" title="打开所在位置">属于「${esc(parent.name)}」</button>` : ''}</div>
    <input class="ins-name" id="f-name" value="${esc(site.name)}" maxlength="60" aria-label="铺源名称">
    <div class="ins-sub">${[Number.isFinite(site.area) ? `${site.area} ㎡` : '', floor,
      Number.isFinite(site.frontage) ? `面宽 ${site.frontage}m` : '',
      Number.isFinite(site.ceilingM) ? `层高 ${site.ceilingM}m` : '',
      Number.isFinite(site.powerKw) ? `电 ${site.powerKw}kW` : ''].filter(Boolean).join('　')}</div>
    <div class="group unit-head">
      <div class="grid2">
        <div class="stat"><span>月租</span><b>${Number.isFinite(site.rent) ? `${money(site.rent)}<small> 元</small>` : '—'}</b></div>
        <div class="stat"><span>单价</span><b>${perDay ? `${perDay}<small> 元/㎡/天</small>` : '—'}</b></div>
        <div class="stat"><span>转让费</span><b>${Number.isFinite(site.transferFee) ? (site.transferFee ? money(site.transferFee) : '无') : '—'}</b></div>
        <div class="stat"><span>渠道</span><b>${esc(String(site.source || '').replace(/^铺源\s*lst-\d+\s*/, '') || '—')}</b></div>
      </div>
    </div>`
}

function renderSiteInspector(site) {
  const sc = scoreOf(site.id)
  const isUnit = site.kind === 'unit'
  els.inspector.innerHTML = `<div class="ins ${isUnit ? 'unit' : ''}">
    ${isUnit ? unitHead(site) : `
    <div class="ins-kicker">已保存点位 · ${esc(sc?.features?.districtType || '')}</div>
    <input class="ins-name" id="f-name" value="${esc(site.name)}" maxlength="60" aria-label="点位名称">`}
    ${decisionBanner(site)}
    ${sc ? contextLines(sc.features) : ''}
    ${sc ? analysisBlock(sc) : ''}
    ${nearbyListingsBlock(site)}
    <div class="group"><h3>铺面资料</h3>
      <label class="field"><span>地址</span><input id="f-address" value="${esc(site.address)}"></label>
      <div class="grid3" style="margin-top:6px">
        <label class="field"><span>面积 ㎡</span><input id="f-area" type="number" value="${esc(site.area ?? '')}"></label>
        <label class="field"><span>面宽 m</span><input id="f-frontage" type="number" step="0.1" value="${esc(site.frontage ?? '')}"></label>
        <label class="field"><span>楼层</span><input id="f-floor" type="number" value="${esc(site.floor ?? '')}"></label>
      </div>
      <div class="grid2" style="margin-top:6px">
        <label class="field"><span>月租 元</span><input id="f-rent" type="number" value="${esc(site.rent ?? '')}"></label>
        <label class="field"><span>转让费 元</span><input id="f-transferFee" type="number" value="${esc(site.transferFee ?? '')}"></label>
      </div>
      <div class="grid2" style="margin-top:6px">
        <label class="field"><span>净层高 m</span><input id="f-ceilingM" type="number" step="0.1" value="${esc(site.ceilingM ?? '')}"></label>
        <label class="field"><span>电容量 kW</span><input id="f-powerKw" type="number" value="${esc(site.powerKw ?? '')}"></label>
      </div>
      <label class="field" style="margin-top:6px"><span>房东 / 联系人</span><input id="f-landlord" value="${esc(site.landlord)}"></label>
      <div class="row-actions"><button class="button primary" id="saveSite" type="button" disabled>资料已保存</button></div>
    </div>
    <div class="group"><h3>硬性条件</h3>
      ${TRI.map(([key, label]) => `<div class="field" style="margin-top:6px"><span>${label}</span><div class="tri">
        <button type="button" data-tri="${key}" data-value="true" class="${site[key] === true ? 'on' : ''}">可以</button>
        <button type="button" data-tri="${key}" data-value="false" class="${site[key] === false ? 'on' : ''}">不行</button>
        <button type="button" data-tri="${key}" data-value="null" class="${site[key] === null ? 'on' : ''}">未确认</button>
      </div></div>`).join('')}
    </div>
    <div class="group"><h3>状态与对比</h3>
      <div class="grid3">${STATUS.map(([v, l]) => `<button class="button ${site.status === v ? 'on' : ''}" data-status="${v}" type="button"
        title="${FINAL.has(site.status) ? `撤回定案，退回「${l}」` : `标记为「${l}」`}">${l}</button>`).join('')}</div>
      <button class="button ${(state.data.compareIds || []).includes(site.id) ? 'on' : ''}" id="toggleCompare" type="button" style="width:100%;margin-top:6px">
        ${(state.data.compareIds || []).includes(site.id) ? '已在对比中' : '加入对比'}</button>
    </div>
    <div class="group"><h3>踩点记录</h3>
      <div class="grid2">
        <label class="field"><span>高峰人流 人/时</span><input id="n-peak" type="number"></label>
        <label class="field"><span>平峰人流 人/时</span><input id="n-off" type="number"></label>
      </div>
      <label class="field" style="margin-top:6px"><span>现场观察</span>
        <textarea id="n-obs" placeholder="动线、对面开什么店、晚间客流…只有到现场才知道的东西。"></textarea></label>
      <div class="row-actions"><button class="button" id="addNote" type="button">保存踩点记录</button></div>
      ${site.fieldNotes.length ? site.fieldNotes.map(n => `<div class="note">
        <em>${esc(new Date(n.at).toLocaleDateString('zh-CN'))} · 高峰 ${fmt(n.peakFlow)} / 平峰 ${fmt(n.offpeakFlow)}</em>
        ${esc(n.observation)}<button data-delete-note="${esc(n.id)}" type="button">×</button></div>`).join('')
        : ''}
    </div>
    <div class="group"><h3>交给 DSH</h3>
      <label class="field"><span>你的问题或要求</span><textarea id="askInput" placeholder="例如：查一下这个点位周边在建项目和地铁规划。"></textarea></label>
      <div class="grid2" style="margin-top:6px">
        <button class="button" data-ask="research" type="button">查商圈信息</button>
        <button class="button" data-ask="brief" type="button">生成材料</button>
      </div>
      <button class="button primary" data-ask="free" type="button" style="width:100%;margin-top:6px">带上这个点位发过去 →</button>
    </div>
    ${decisionGroup(site)}
  </div>`
  state.rendered = { id: site.id, fields: Object.fromEntries(FIELDS.map(f => [f, String(site[f] ?? '')])) }
  markDirty()
  // The flag outlives one render on purpose: selecting the site also posts
  // `select`, whose reply re-renders this panel a beat later. Clearing the
  // flag on first render lost the highlight before anyone saw it.
  if (state.flashDecision === site.id) {
    const group = $('decideGroup')
    group?.classList.add('flash')
    if (!state.flashTimer) {
      group?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      state.flashTimer = setTimeout(() => {
        state.flashDecision = null
        state.flashTimer = null
        $('decideGroup')?.classList.remove('flash')
      }, 2400)
    }
  }
}

/**
 * A decided site says so before anything else. The result used to live at the
 * very bottom of the inspector, under the analysis and the forms, so a signed
 * site opened looking exactly like one still being weighed.
 */
function decisionBanner(site) {
  if (!FINAL.has(site.status) || !site.decision) return ''
  const d = site.decision
  const why = [...(d.reasons || []), d.note].filter(Boolean).join('；')
  return `<div class="decision-banner ${esc(d.result)}">
    <b>${d.result === 'signed' ? '✓ 已签约' : '× 已否决'}</b>
    <span>${esc(decisionWhen(d))}${why ? ` · ${esc(why)}` : ''}</span>
  </div>`
}

/**
 * 定案: either the two verbs, or the record of the one that was chosen and a
 * way back. A decided site does not offer 签约/否决 again — undoing goes
 * through 退回上会, which clears the record on the server.
 */
function decisionGroup(site) {
  const d = FINAL.has(site.status) ? site.decision : null
  const body = d ? `
      <div class="decision-card ${esc(d.result)}">
        <em>${d.result === 'signed' ? '已签约' : '已否决'}${d.at ? ` · ${esc(new Date(d.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}</em>
        ${d.reasons?.length ? `<div class="reasons">${d.reasons.map(r => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
        ${d.note ? `<p>${esc(d.note)}</p>` : (d.result === 'signed' ? '<p>没有附加说明。</p>' : '')}
      </div>
      <div class="row-actions"><button class="button" data-status="review" type="button" title="清掉这条定案记录，点位回到上会中">‹ 撤回定案，退回上会中</button></div>`
    : `
      <div class="grid2">
        <button class="button on" id="doSign" type="button">✓ 签约</button>
        <button class="button danger" id="doReject" type="button">× 否决</button>
      </div>
      ${site.status !== 'review' ? '<p class="hint">还没上会也可以直接定案；定案后可以退回。</p>' : ''}`
  const title = d ? `定案 · <span class="st st-${esc(d.result)}">${d.result === 'signed' ? '已签约' : '已否决'}</span>` : '定案'
  return `<div class="group decide" id="decideGroup"><h3>${title}</h3>${body}
      <div class="row-actions"><button class="button subtle" id="deleteSite" type="button">删除这个点位</button></div>
    </div>`
}

/** How the score is built, and what the data can and cannot say. */
function methodBlock() {
  const m = rankModel()
  const p = state.data.project
  const mode = {
    district: ['全区基线', m?.basis === 'format' && m.formatLabel
      ? `以${esc(p.city || '本区')}已开的 ${m.sampleSize} 家${esc(m.formatLabel)}店为尺子。`
      : `以${esc(p.city || '本区')}全部 ${m?.sampleSize ?? '—'} 个已有商业位置为尺子。`],
    reference: ['参照品牌', `以 ${esc(p.referenceBrand || '参照品牌')} 已开门店的位置分布为尺子。`],
    none: ['缺少数据', '这个项目还没有绑定城市数据集。'],
  }[state.mode] || ['—', '']

  return `<div class="method">
    <h4><span class="mode-pill">${mode[0]}</span>评分方法</h4>
    <p>${mode[1]}综合分 = 三个维度百分位的平均。</p>
    <table class="table"><thead><tr><th>维度</th><th>指标</th></tr></thead><tbody>
      ${METRIC_GROUPS.map(g => `<tr><td><b>${esc(g.label)}</b></td>
        <td>${esc(BENCH_METRICS.filter(x => x.group === g.key).map(x => x.label).join('、'))}</td></tr>`).join('')}
      <tr class="dim"><td>竞争</td><td>500m 内同业态门店　<small>不计分</small></td></tr>
      <tr class="dim"><td>客群结构</td><td>${esc(CUSTOMER_SEGMENTS.map(c => c.label).join('、'))}　<small>不计分</small></td></tr>
    </tbody></table>
    <p><b>一票否决</b>：无排烟、无食品经营许可、无独立上下水；距同品牌门店过近；周边建筑面积过低。</p>
  </div>`
}

function renderRef() {
  const m = rankModel()
  if (!m?.ready) {
    els.views.ref.innerHTML = methodBlock() + `<div class="empty">${esc(m?.reason || '这个项目还没有可用的评分基线')}</div>`
    return
  }
  const cmp = m.comparison
  els.views.ref.innerHTML = methodBlock() + `
    <div class="brand-head">
      <div class="stat"><span>${esc(m.brandLabel)}</span><b>${m.sampleSize}<small> 个</small></b></div>
      ${m.spacing ? `<div class="stat"><span>门店间距中位</span><b>${m.spacing.median}<small> m</small></b></div>` : ''}
      ${m.metrics.map(x => `<div class="stat"><span>${esc(x.label)}中位</span><b>${x.scale > 1 ? (x.median / x.scale).toFixed(0) : Math.round(x.median)}<small> ${esc(x.unit)}</small></b></div>`).join('')}
    </div>
    <div class="statements">${m.statements.map(s => `<p>${esc(s)}</p>`).join('')}</div>
    <h3 class="section-title">参照分布</h3>
    <table class="table"><thead><tr><th>指标</th><th>p10</th><th>p25</th><th>中位</th><th>p75</th><th>p90</th><th>样本</th></tr></thead><tbody>
    ${m.metrics.map(x => { const s = x.scale || 1; const f = v => (s > 1 ? (v / s).toFixed(1) : Math.round(v))
      return `<tr><td>${esc(x.label)}<small class="dim"> ${esc(x.unit)}</small></td>
        <td class="num">${f(x.p10)}</td><td class="num">${f(x.p25)}</td><td class="num">${f(x.median)}</td>
        <td class="num">${f(x.p75)}</td><td class="num">${f(x.p90)}</td><td class="num">${x.n}</td></tr>` }).join('')}
    </tbody></table>
    ${cmp?.ready ? `<h3 class="section-title">与本地同类店的差异</h3>
    <table class="table"><thead><tr><th>指标</th><th>${esc(m.brandLabel)}</th><th>同类店</th><th>比值</th><th>效应量 d</th><th>是否显著</th></tr></thead><tbody>
    ${cmp.features.map(f => `<tr class="${f.significant ? '' : 'dim'}"><td>${esc(f.label)}</td>
      <td class="num">${f.brandMean}</td><td class="num">${f.backgroundMean}</td>
      <td class="num">${f.ratio ?? '—'}</td><td class="num">${f.d}</td>
      <td>${f.significant ? '显著' : '不显著'}</td></tr>`).join('')}
    </tbody></table>` : ''}`
}

/** Every saved site, always compared, always current — no opting in. */
function renderCompare() {
  const all = sites()
  els.compareCount.textContent = all.length
  if (!all.length) {
    els.views.compare.innerHTML = `<div class="empty">还没有点位<br><br>
      在地图上点一下保存，或跟 DSH 说你的要求
      <div class="row-actions" style="max-width:220px;margin:16px auto 0">
        <button class="button primary" data-ask="find" type="button">跟 DSH 说我的要求</button>
      </div></div>`
    return
  }
  const model = rankModel()
  const cols = model?.metrics || []
  const { key, dir } = state.sort
  const val = (site, k) => {
    const sc = scoreOf(site.id) || {}
    if (k === 'score') return sc.score ?? -1
    if (k === 'name') return site.name
    if (k === 'status') return site.status
    if (k === 'area') return site.area ?? -1
    if (k === 'rent') return site.rent ?? -1
    if (k === 'notes') return site.fieldNotes.length
    return sc.metrics?.find(m => m.key === k)?.percentile ?? -1
  }
  const rows = [...all].sort((a, b) => {
    const x = val(a, key), y = val(b, key)
    if (typeof x === 'string') return dir * String(x).localeCompare(String(y), 'zh')
    return dir * (x - y)
  })
  const th = (k, label) => `<th data-sort="${k}" class="${key === k ? 'on' : ''}">${label}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`

  els.views.compare.innerHTML = `
    <div style="overflow:auto"><table class="sites-table"><thead><tr>
      ${th('score', '综合分')}${th('name', '点位')}${th('status', '状态')}
      ${cols.map(c => th(c.key, c.label.replace('500m 内', '').replace('最近', ''))).join('')}
      ${th('area', '面积')}${th('rent', '月租')}${th('notes', '踩点')}
      <th>提示</th>
    </tr></thead><tbody>
    ${rows.map(site => {
      const sc = scoreOf(site.id) || {}
      const cells = cols.map(c => {
        const m = sc.metrics?.find(x => x.key === c.key)
        return `<td class="num"><span class="pct-cell ${m?.verdict || ''}">${m ? m.percentile : '—'}</span></td>`
      }).join('')
      const flags = [...(sc.flags || []), ...(sc.exclusions || [])]
      return `<tr data-site="${esc(site.id)}" class="${site.id === state.selection ? 'selected' : ''}">
        <td class="num"><span class="pill ${esc(sc.tier || '')}">${sc.score ?? '—'}</span></td>
        <td>${esc(site.name)}</td>
        <td><span class="st st-${esc(site.status)}">${esc(STATUS_LABEL[site.status] || site.status)}</span></td>
        ${cells}
        <td class="num">${site.area ?? '—'}</td>
        <td class="num">${site.rent ? Math.round(site.rent / 1000) + 'k' : '—'}</td>
        <td class="num">${site.fieldNotes.length}</td>
        <td>${flags.length ? esc(flags[0].text.slice(0, 26)) + (flags.length > 1 ? ` +${flags.length - 1}` : '') : ''}</td>
      </tr>`
    }).join('')}
    </tbody></table></div>
    <div class="row-actions" style="max-width:320px;margin-top:12px">
      <button class="button" data-ask="compare" type="button">让 DSH 分析这批点位</button>
    </div>`
}

function renderLog() {
  els.views.log.innerHTML = (state.data.activity || []).map(e => `<div class="log-item">
    <time>${esc(new Date(e.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time>
    <p>${esc(e.text)}</p></div>`).join('') || '<div class="empty">还没有记录</div>'
}

/**
 * The simulated commercial layer.
 *
 * Rendered in its own tab, with its own colour and a standing banner, because
 * the one confusion that would actually cost someone money is mistaking one of
 * these rents for a real one.
 */
function renderMarket() {
  const node = els.views.market
  if (!node) return
  const mk = state.market
  if (!mk) { node.innerHTML = '<div class="empty">这个城市还没有生成模拟商业数据。</div>'; return }

  const live = sites().filter(x => Number.isFinite(x.lng) && x.status !== 'rejected')
  const radius = state.marketRadius || 400
  const near = (row) => live.reduce((best, x) => {
    const d = haversine(x, row)
    return !best || d < best.d ? { d, site: x } : best
  }, null)

  const rows = []
  for (const l of mk.listings) {
    if (l.status !== '在租') continue
    const hit = near(l)
    if (!hit || hit.d > radius) continue
    rows.push({ ...l, d: Math.round(hit.d), site: hit.site })
  }
  rows.sort((a, b) => a.d - b.d)

  const money = v => (v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : String(v))
  node.innerHTML = `
    <div class="market-head">
      <div class="stat"><span>在租铺源（全城）</span><b>${mk.counts.listings}</b></div>
      <div class="stat"><span>客流网格</span><b>${mk.counts.footfall}</b></div>
      <div class="stat"><span>商场</span><b>${mk.counts.malls}</b></div>
      <div class="stat"><span>你的点位 ${radius}m 内</span><b>${rows.length}</b></div>
      <div class="market-radius">
        ${[200, 400, 800].map(r => `<button class="chip ${r === radius ? 'on' : ''}" data-radius="${r}" type="button">${r}m</button>`).join('')}
      </div>
    </div>
    ${!rows.length ? `<div class="empty">${live.length ? `${radius}m 内没有在租铺源` : '还没有点位'}</div>` : `
    <table class="table market-table"><thead><tr>
      <th>铺源</th><th>面积</th><th>月租</th><th>元/㎡/天</th><th>转让费</th><th>前身</th><th>硬性条件</th><th>距点位</th>
    </tr></thead><tbody>
    ${rows.slice(0, 60).map(l => {
      const gate = [l.hasFlue ? null : '无排烟', l.hasWater ? null : '无上下水', l.canLicense ? null : '办不出证'].filter(Boolean)
      return `<tr data-listing="${esc(l.id)}">
        <td><b>${esc(l.address)}</b><small class="dim"> ${esc(l.id)}　${l.floor === 1 ? '首层' : l.floor === -1 ? '地下一层' : `${l.floor}层`}${l.inMall ? `·商场内${l.mallTier ? `（${esc(l.mallTier)}）` : ''}` : ''}</small></td>
        <td class="num">${l.areaSqm} ㎡</td>
        <td class="num">${money(l.rentPerMonth)}</td>
        <td class="num">${l.rentPerSqmDay}</td>
        <td class="num">${l.transferFee ? money(l.transferFee) : '—'}</td>
        <td><small>${esc(l.formerUse)}</small></td>
        <td>${gate.length ? `<span class="gate-bad">${esc(gate.join('、'))}</span>` : '<span class="gate-ok">齐全</span>'}</td>
        <td class="num"><small>${l.d}m<br>${esc(l.site.name.slice(0, 10))}</small></td>
      </tr>`
    }).join('')}
    </tbody></table>`}
  `
}

function renderViews() {
  for (const [k, node] of Object.entries(els.views)) node.hidden = state.view !== k
  document.querySelectorAll('[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === state.view))
  if (state.view === 'map' && mapReady) { map.resize(); drawMap() }
}

function renderAll({ keepInspector = true } = {}) {
  if (!state.data) return
  const snap = keepInspector ? captureInspector() : null
  renderTop(); renderRail(); renderInspector(); renderRef(); renderCompare(); renderMarket(); renderLog(); renderViews()
  if (mapReady) { rebuildMarkers(); drawMap() }
  restoreInspector(snap)
}

// ══ DIRTY TRACKING ═══════════════════════════════════════
function inspectorValues() {
  if (!state.rendered) return null
  const out = {}
  for (const f of FIELDS) {
    const node = $(`f-${f}`)
    if (!node) return null
    out[f] = node.value
  }
  return out
}
function isDirty() {
  const cur = inspectorValues()
  return !!cur && FIELDS.some(f => cur[f] !== state.rendered.fields[f])
}
function captureInspector() {
  const values = inspectorValues()
  if (!values || !isDirty()) return null
  const a = document.activeElement
  return { id: state.rendered.id, values, focus: a?.id || '', scroll: els.inspector.scrollTop }
}
function restoreInspector(snap) {
  if (!snap || snap.id !== selectedSite()?.id) return
  for (const f of FIELDS) { const n = $(`f-${f}`); if (n) n.value = snap.values[f] }
  els.inspector.scrollTop = snap.scroll
  const focus = snap.focus && $(snap.focus)
  if (focus) focus.focus()
  markDirty()
}
function markDirty() {
  const dirty = isDirty()
  for (const f of FIELDS) $(`f-${f}`)?.closest('.field')?.classList.toggle('dirty', dirty)
  const btn = $('saveSite')
  if (btn) { btn.disabled = !dirty; btn.textContent = dirty ? '保存资料' : '资料已保存' }
}

// ══ SERVER ═══════════════════════════════════════════════
async function callJson(path, options) {
  const response = await fetch(path, options)
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
  return result
}
function adopt(data) {
  state.data = data.state
  state.scores = data.scores || {}
  state.mode = data.mode || 'yield'
  if (data.folder) state.folder = data.folder
  if (data.revision !== undefined) state.revision = data.revision
}

async function load({ quiet = false } = {}) {
  if (!quiet) setSync('同步中…')
  try {
    const result = await callJson(api('/api/site-selection/bootstrap'), { cache: 'no-store' })
    const first = !state.data
    if (state.data && result.revision === state.revision) { setSync('已同步'); return }
    if (state.data && isDirty()) {
      state.pending = result
      els.stale.hidden = false
      setSync('DSH 有新改动')
      return
    }
    adopt(result)
    // Nothing is being held back any more, so the banner must not linger — it
    // used to be cleared only by its own buttons.
    els.stale.hidden = true
    state.pending = null
    if (first && result.state.project.dataset) {
      setSync('正在载入城市数据…')
      await loadDataset(result.state.project.dataset)
    }
    renderAll()
    els.app.classList.add('ready')
    els.app.setAttribute('aria-busy', 'false')
    setSync('已同步')
  } catch (error) {
    setSync('同步失败', 'error')
    if (!quiet) toast(error.message)
  }
}

async function action(payload, success) {
  if (state.saving) return null
  state.saving = true
  setSync('保存中…')
  try {
    const result = await callJson('/api/site-selection/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, project }),
    })
    state.revision = ''
    adopt(result)
    renderAll({ keepInspector: payload.type !== 'update-site' })
    if (success !== null) toast(success || result.log || '已保存')
    setSync('已同步')
    return result
  } catch (error) {
    toast(`保存失败：${error.message}`)
    setSync('保存失败', 'error')
    return null
  } finally { state.saving = false }
}

/**
 * @param fly  recentre the map on the site. True when the click came from a
 *             list (you cannot see where it is), false when it came from the
 *             map itself (you are already looking at it, moving would jar).
 */
function selectSite(id, { fly = false } = {}) {
  state.selection = id
  state.probe = null
  const site = sites().find(s => s.id === id)
  if (fly && site && Number.isFinite(site.lng)) {
    map.view.cx = site.lng
    map.view.cy = site.lat
    map.view.dist = Math.min(map.view.dist, 1100)
    if (state.view !== 'map') { state.view = 'map'; renderViews() }
  }
  rebuildMarkers(); drawMap(); renderInspector(); renderRail()
  action({ type: 'select', id }, null)
}

// ══ DSH BRIDGE ═══════════════════════════════════════════
function ask(mode, payload) {
  const site = selectedSite()
  const probing = state.selection === '__probe__' && state.probe
  window.parent.postMessage({
    type: 'dsh-site-selection:ask', project, mode,
    site: site || (probing ? { id: '__probe__', name: '地图上刚点的位置', lng: state.probe.point.lng, lat: state.probe.point.lat } : null),
    score: site ? scoreOf(site.id) : (probing ? state.probe : null),
    request: $('askInput')?.value?.trim() || '',
    payload: payload || null,
  }, window.location.origin)
}

// ══ MODAL ════════════════════════════════════════════════
let modalResolve = null
let modalKind = 'text'
function openModal({ title, hint = '', kind = 'text', placeholder = '', value = '', ok = '确定', danger = false }) {
  modalKind = kind
  $('modalTitle').textContent = title
  $('modalHint').textContent = hint
  $('modalHint').hidden = !hint
  const area = $('modalText'), input = $('modalInput')
  area.hidden = kind !== 'text'; input.hidden = kind !== 'input'
  area.value = kind === 'text' ? value : ''
  input.value = kind === 'input' ? value : ''
  area.placeholder = input.placeholder = placeholder
  $('modalOk').textContent = ok
  $('modalOk').dataset.danger = String(danger)
  $('modal').hidden = false
  ;(kind === 'text' ? area : kind === 'input' ? input : $('modalOk')).focus()
  if (kind === 'input') input.select()
  return new Promise(resolve => { modalResolve = resolve })
}
function closeModal(value) { $('modal').hidden = true; modalResolve?.(value); modalResolve = null }
const confirmModal = opts => openModal({ ...opts, kind: 'confirm' }).then(v => v === true)
$('modalCancel').onclick = () => closeModal(modalKind === 'confirm' ? false : null)
$('modalForm').addEventListener('submit', e => {
  e.preventDefault()
  closeModal(modalKind === 'confirm' ? true : (modalKind === 'input' ? $('modalInput').value : $('modalText').value))
})

// ══ EVENTS ═══════════════════════════════════════════════
els.rail.addEventListener('click', e => {
  const advance = e.target.closest('[data-advance]')
  if (advance) {
    e.stopPropagation()
    const id = advance.dataset.advance
    if (advance.dataset.to === '__decide__') {
      // 去定案 is a promise to land on the 签约/否决 buttons: open the panel if
      // it is folded away, then light the group up once it is rendered.
      if (!state.inspectorOpen) setInspector(true)
      state.flashDecision = id
      selectSite(id, { fly: true })
      return
    }
    action({ type: 'site-status', id, status: advance.dataset.to })
    return
  }
  // Going back. Forward is one click on the row; without this the only way to
  // undo a mis-click was to open the site and hunt for the status row.
  const back = e.target.closest('[data-back]')
  if (back) {
    e.stopPropagation()
    action({ type: 'site-status', id: back.dataset.back, status: back.dataset.to })
    return
  }
  const row = e.target.closest('[data-site]')
  if (!row) return
  if (row.dataset.site === '__probe__') {
    state.selection = '__probe__'
    rebuildMarkers(); drawMap(); renderInspector(); renderRail()
  } else if (row.dataset.site !== state.selection) selectSite(row.dataset.site, { fly: true })
})

$('railFilters').addEventListener('click', e => {
  const btn = e.target.closest('[data-filter]')
  if (!btn) return
  state.filter = btn.dataset.filter
  document.querySelectorAll('[data-filter]').forEach(n => n.classList.toggle('active', n === btn))
  renderRail()
})

// Delegated from `.stage`, not `.stage-nav`: the listings toggle lives on the
// map and the radius chips live in the 铺源 view, so a listener bound to the nav
// never saw either of them. The radius chips had never worked at all.
document.querySelector('.stage').addEventListener('click', e => {
  if (e.target.closest('#toggleListings')) {
    state.showListings = !state.showListings
    $('toggleListings').classList.toggle('on', state.showListings)
    if (mapReady) { rebuildMarkers(); drawMap() }
    return
  }

  const radiusChip = e.target.closest('[data-radius]')
  if (radiusChip) {
    state.marketRadius = Number(radiusChip.dataset.radius)
    renderMarket()
    return
  }

  const tab = e.target.closest('[data-view]')
  if (!tab) return
  state.view = tab.dataset.view
  renderViews()
})

els.legend.addEventListener('click', e => {
  const btn = e.target.closest('[data-layer]')
  if (!btn) return
  map.layers[btn.dataset.layer] = !map.layers[btn.dataset.layer]
  btn.dataset.on = String(map.layers[btn.dataset.layer])
  drawMap()
})

els.inspector.addEventListener('click', async e => {
  const open = e.target.closest('[data-open-site]')
  if (open) return selectSite(open.dataset.openSite, { fly: true })
  const pick = e.target.closest('[data-pick-listing]')
  if (pick && !e.target.closest('[data-listing]')) {
    const l = state.market?.listings.find(x => x.id === pick.dataset.pickListing)
    if (l) { state.selection = `__listing__${l.id}`; state.probe = null; renderAll(); rebuildMarkers(); drawMap() }
    return
  }
  const adopt = e.target.closest('[data-listing]')
  if (adopt) {
    const l = state.market?.listings.find(x => x.id === adopt.dataset.listing)
    if (l) { await action({ type: 'adopt-listing', listing: l }, null); toast('已收进点位清单') }
    return
  }
  const askBtn = e.target.closest('[data-ask]')
  if (askBtn) return ask(askBtn.dataset.ask)

  if (e.target.closest('#saveProbe')) {
    const r = state.probe
    if (!r) return
    const name = await openModal({ title: '保存为候选点位', kind: 'input', ok: '保存',
      hint: `综合 ${r.score} 分`,
      value: `候选点位 ${sites().length + 1}`, placeholder: '给这个点起个名字' })
    if (!name?.trim()) return
    const res = await action({ type: 'create-site', site: { name: name.trim(), lng: r.point.lng, lat: r.point.lat, source: '地图选点' } }, '已保存')
    if (res) {
      state.probe = null
      state.selection = res.state.sites.at(-1)?.id ?? null
      renderAll({ keepInspector: false })
    }
    return
  }

  const site = selectedSite()
  if (!site) return
  const tri = e.target.closest('[data-tri]')
  if (tri) {
    const raw = tri.dataset.value
    return action({ type: 'update-site', id: site.id, patch: { [tri.dataset.tri]: raw === 'null' ? null : raw === 'true' } }, null)
  }
  const status = e.target.closest('[data-status]')
  if (status) return action({ type: 'site-status', id: site.id, status: status.dataset.status })
  const del = e.target.closest('[data-delete-note]')
  if (del) return action({ type: 'delete-note', id: site.id, noteId: del.dataset.deleteNote })

  if (e.target.closest('#saveSite')) {
    const patch = {}
    for (const f of FIELDS) {
      const raw = $(`f-${f}`).value
      patch[f] = NUMS.has(f) ? (raw === '' ? null : Number(raw)) : raw
    }
    return action({ type: 'update-site', id: site.id, patch }, '资料已保存')
  }
  if (e.target.closest('#toggleCompare')) {
    const ids = new Set(state.data.compareIds || [])
    const adding = !ids.has(site.id)
    adding ? ids.add(site.id) : ids.delete(site.id)
    if (ids.size > 4) return toast('最多同时对比四个点位')
    await action({ type: 'compare', ids: [...ids] }, null)
    toast(adding
      ? (ids.size < 2 ? `已加入对比（再选 ${2 - ids.size} 个就能并排看）` : `对比中共 ${ids.size} 个点位`)
      : '已移出对比')
    return
  }
  if (e.target.closest('#addNote')) {
    return action({ type: 'field-note', id: site.id,
      peakFlow: $('n-peak').value, offpeakFlow: $('n-off').value, observation: $('n-obs').value }, '踩点记录已保存')
  }
  if (e.target.closest('#doSign')) {
    if (await confirmModal({ title: `确认签约「${site.name}」？`, ok: '确认签约', hint: '会写进决策记录。' })) {
      action({ type: 'decide', id: site.id, result: 'signed' })
    }
    return
  }
  if (e.target.closest('#doReject')) {
    const note = await openModal({ title: `否决「${site.name}」`, ok: '确认否决',
      hint: `理由会进决策记录。常见：${REJECT.join(' / ')}`,
      placeholder: '例如：租金过高' })
    if (note?.trim()) {
      action({ type: 'decide', id: site.id, result: 'rejected', reasons: REJECT.filter(r => note.includes(r)), note: note.trim() })
    }
    return
  }
  if (e.target.closest('#deleteSite')) {
    if (await confirmModal({ title: `删除「${site.name}」？`, ok: '删除', danger: true,
      hint: '无法撤销。' })) {
      state.selection = null
      action({ type: 'delete-site', id: site.id }, '点位已删除')
    }
    return
  }
})
els.inspector.addEventListener('input', e => { if (e.target.id?.startsWith('f-')) markDirty() })
// ── all-sites table events ──
els.views.compare.addEventListener('click', e => {
  if (e.target.closest('[data-ask]')) return ask('compare')
  const th = e.target.closest('[data-sort]')
  if (th) {
    const key = th.dataset.sort
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'name' ? 1 : -1 }
    return renderCompare()
  }
  const row = e.target.closest('[data-site]')
  if (row) selectSite(row.dataset.site, { fly: true })
})

// ══ SEARCH ═══════════════════════════════════════════════
const CAT_LABEL = { food: '餐饮', shop: '商场', transit: '地铁', health: '医疗', edu: '学校',
  park: '公园', stay: '酒店', work: '办公', place: '地点', road: '道路' }
const CAT_COLOR = { food: '#e07b2e', shop: '#cf7a20', transit: '#3b7cd3', health: '#dc4b4b',
  edu: '#6b7fd6', park: '#3f9e57', stay: '#8f5fc4', work: '#7b848c', place: '#6f777d', road: '#9aa2a8' }

function searchPlaces(query) {
  const q = query.trim().toLowerCase()
  if (q.length < 1) return []
  const pool = [...state.searchable, ...state.searchRoads]
  const hits = []
  for (const p of pool) {
    const name = String(p.name || '')
    const i = name.toLowerCase().indexOf(q)
    if (i < 0) continue
    // prefix matches first, then shorter names, then higher-priority categories
    hits.push({ p, rank: (i === 0 ? 0 : 1) * 1000 + name.length * 4 + (p.pri ?? 4) })
    if (hits.length > 400) break
  }
  hits.sort((a, b) => a.rank - b.rank)
  return hits.slice(0, 12).map(h => h.p)
}

function flyTo(place) {
  map.view.cx = place.lng
  map.view.cy = place.lat
  map.view.dist = Math.min(map.view.dist, 1100)
  state.view = 'map'
  renderViews()
  probeAt(place.lng, place.lat)
  toast(`已定位到「${place.name}」`)
}

let searchActive = -1
function renderSearch(results) {
  const box = $('searchResults')
  if (!results.length) {
    box.hidden = !$('searchInput').value.trim()
    box.innerHTML = '<div class="search-empty">没有匹配的地点</div>'
    return
  }
  box.hidden = false
  box.innerHTML = results.map((p, i) => `<div class="search-item" data-idx="${i}" data-active="${i === searchActive}">
    <i style="background:${CAT_COLOR[p.cat] || CAT_COLOR.place}"></i>
    <b>${esc(p.name)}</b><small>${esc(CAT_LABEL[p.cat] || '')}</small></div>`).join('')
}

let searchHits = []
$('searchInput').addEventListener('input', e => {
  searchActive = -1
  searchHits = searchPlaces(e.target.value)
  renderSearch(searchHits)
})
$('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('searchResults').hidden = true; e.target.blur(); return }
  if (!searchHits.length) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length
    renderSearch(searchHits)
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const pick = searchHits[searchActive >= 0 ? searchActive : 0]
    if (pick) { flyTo(pick); $('searchResults').hidden = true }
  }
})
$('searchResults').addEventListener('click', e => {
  const row = e.target.closest('[data-idx]')
  if (!row) return
  const pick = searchHits[Number(row.dataset.idx)]
  if (pick) { flyTo(pick); $('searchResults').hidden = true }
})
document.addEventListener('click', e => {
  if (!e.target.closest('.map-search')) $('searchResults').hidden = true
})

$('pasteListings').onclick = async () => {
  const raw = await openModal({
    title: '解析铺源信息', ok: '交给 DSH 解析',
    hint: '粘贴中介或房东发来的原始文字，DSH 解析成候选点位；拿不准的字段留空。',
    placeholder: '朝阳区建国路XX号 临街一层 95平 面宽5米 月租4.2万 转让费15万 可排烟\n三里屯XX号 60平 3.5万/月 无燃气 房东李先生',
  })
  if (raw?.trim()) ask('parse', raw.trim())
}
$('staleReload').onclick = () => {
  if (!state.pending) return
  adopt(state.pending); state.pending = null
  els.stale.hidden = true
  renderAll({ keepInspector: false })
  setSync('已同步')
}
$('staleDismiss').onclick = () => { els.stale.hidden = true }

window.addEventListener('message', e => {
  if (e.origin !== window.location.origin) return
  if (e.data?.type === 'dsh-site-selection:ask-result') {
    toast(e.data.ok ? '已填进右侧 DSH 输入框，确认后按回车' : `发送失败：${e.data.error}`)
  }
  if (e.data?.type === 'dsh-site-selection:bound') {
    els.bind.textContent = e.data.ok ? '● 已绑定会话' : '○ 未绑定'
    els.bind.dataset.ok = String(!!e.data.ok)
    els.bind.title = e.data.detail || ''
  }
})
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(modalKind === 'confirm' ? false : null) })
window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = '' } })

// Exposed for debugging from the DSH console — the panel runs in an iframe with
// no devtools of its own, so this is the only handle on camera and model state.
window.__siteSelection = { map, state, probeAt, drawMap, fitMap }

// ══ INIT ═════════════════════════════════════════════════
els.legend.innerHTML = LAYERS.map(l => `<button class="legend-item" data-layer="${l.key}"
  data-on="${l.on}" type="button" title="点击显示 / 隐藏这层的点位。地名标注不受影响，一直显示">
  <i style="background:${l.color}"></i>${esc(l.label)}</button>`).join('')

setInspector(state.inspectorOpen)
setRail(state.railOpen)

if (!project) {
  els.app.classList.add('ready')
  els.inspector.innerHTML = '<div class="inspector-empty">缺少 project 参数</div>'
} else {
  // The parent registers its listener inside a React effect, which may not have
  // run yet when this iframe boots — ask a few times until it answers.
  let asked = 0
  const askWho = setInterval(() => {
    if (els.bind.dataset.ok || asked > 8) return clearInterval(askWho)
    asked += 1
    window.parent.postMessage({ type: 'dsh-site-selection:whoami', project }, window.location.origin)
  }, 700)
  load()

  /**
   * Wait for DSH to touch project.json, then reload.
   *
   * Not a timer: this iframe reports `visibilityState: 'hidden'`, so Chrome
   * throttles its timers hard — a 1 s interval measured 6 fires in 13 s, and
   * background throttling can stretch it to once a minute. That is why a site
   * DSH had just deleted stayed on screen. An in-flight request is not subject
   * to that, so the update now lands as soon as the file changes.
   */
  async function watchLoop() {
    for (;;) {
      try {
        const r = await callJson(api('/api/site-selection/watch', { since: state.revision || '' }),
          { cache: 'no-store' })
        if (r.changed) await load({ quiet: true })
      } catch {
        // Server restart or a dropped socket — back off briefly and re-arm.
        await new Promise(done => setTimeout(done, 2000))
      }
    }
  }
  watchLoop()
  // Belt and braces: if the long poll is blocked by something in the middle,
  // a throttled timer is still better than nothing.
  setInterval(() => load({ quiet: true }), 15000)
}
