/**
 * A dependency-free 3D map: real building footprints extruded to their real
 * heights, drawn with a pinhole camera and the painter's algorithm on a 2D
 * canvas. No tiles, no key, works offline — and it is the only way to render
 * mainland building data without a licensed basemap provider.
 *
 * Note: this panel's iframe never receives frame callbacks from Chrome
 * (requestAnimationFrame measured at 0 fires/sec), so every redraw is driven
 * synchronously from the event that caused it.
 */
(() => {
  const M_LAT = 110540
  const mPerLng = lat => 111320 * Math.cos((lat * Math.PI) / 180)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

  class Map3D {
    constructor(canvas) {
      this.canvas = canvas
      this.ctx = canvas.getContext('2d')
      this.view = { cx: 116.4600, cy: 39.9120, dist: 2600, bearing: 0.6, pitch: 0.85 }
      this.W = 0; this.H = 0; this.dpr = 1
      this.buildings = []   // { pts:[[x,y]], h, k, n, cx, cy, radius }
      this.areas = []       // { cls, pts:[[x,y]], cx, cy, radius }
      this.roads = []       // { cls, pts:[[x,y]], cx, cy, radius }
      this.pois = []        // { x, y, layer }
      this.labelPoints = [] // { x, y, name, cat, pri }
      this.markers = []     // { x, y, label, color, id, kind }
      this.rings = []       // { x, y, radii:[m], color }
      this.layers = {}
      this.quality = 'full'
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return false
      this.dpr = window.devicePixelRatio || 1
      this.W = Math.round(rect.width); this.H = Math.round(rect.height)
      this.canvas.width = this.W * this.dpr
      this.canvas.height = this.H * this.dpr
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      return true
    }

    // ── world (lng/lat) ↔ local metres about the view centre ──
    toLocal(lng, lat) {
      return [(lng - this.view.cx) * mPerLng(this.view.cy), (lat - this.view.cy) * M_LAT]
    }
    toLngLat(x, y) {
      return [this.view.cx + x / mPerLng(this.view.cy), this.view.cy + y / M_LAT]
    }

    camera() {
      const { dist, bearing, pitch } = this.view
      const p = clamp(pitch, 0.26, 1.48)          // ~15°..85°, avoids the degenerate top-down basis
      const cp = Math.cos(p), sp = Math.sin(p)
      const cb = Math.cos(bearing), sb = Math.sin(bearing)
      const eye = [-dist * cp * sb, -dist * cp * cb, dist * sp]
      const f = eye.map(v => -v / dist)                       // forward: eye → origin
      let r = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0]   // cross(f, worldUp)
      const rl = Math.hypot(r[0], r[1]) || 1
      r = [r[0] / rl, r[1] / rl, 0]
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
      const focal = (this.H / 2) / Math.tan((50 * Math.PI) / 180 / 2)
      return { eye, f, r, u, focal }
    }

    project(cam, x, y, z) {
      const vx = x - cam.eye[0], vy = y - cam.eye[1], vz = z - cam.eye[2]
      const depth = vx * cam.f[0] + vy * cam.f[1] + vz * cam.f[2]
      if (depth < 40) return null
      const sx = vx * cam.r[0] + vy * cam.r[1] + vz * cam.r[2]
      const sy = vx * cam.u[0] + vy * cam.u[1] + vz * cam.u[2]
      return [this.W / 2 + (cam.focal * sx) / depth, this.H / 2 - (cam.focal * sy) / depth, depth]
    }

    /** Screen pixel → the point on the ground plane it points at. */
    unproject(px, py) {
      const cam = this.camera()
      const ndcX = (px - this.W / 2) / cam.focal
      const ndcY = -(py - this.H / 2) / cam.focal
      const dir = [
        cam.f[0] + ndcX * cam.r[0] + ndcY * cam.u[0],
        cam.f[1] + ndcX * cam.r[1] + ndcY * cam.u[1],
        cam.f[2] + ndcX * cam.r[2] + ndcY * cam.u[2],
      ]
      if (Math.abs(dir[2]) < 1e-6) return null
      const t = -cam.eye[2] / dir[2]
      if (t <= 0) return null
      return this.toLngLat(cam.eye[0] + dir[0] * t, cam.eye[1] + dir[1] * t)
    }

    setBuildings(list) {
      this.buildings = list.map(b => {
        const pts = b.r.map(([lng, lat]) => this.toLocalAbs(lng, lat))
        let cx = 0, cy = 0
        for (const p of pts) { cx += p[0]; cy += p[1] }
        cx /= pts.length; cy /= pts.length
        let radius = 0
        for (const p of pts) radius = Math.max(radius, Math.hypot(p[0] - cx, p[1] - cy))
        return { pts, h: b.h, k: b.k, n: b.n, cx, cy, radius }
      })
    }
    /** Buildings are stored in metres about a fixed anchor so panning is cheap. */
    setAnchor(lng, lat) { this.anchor = { lng, lat, mx: mPerLng(lat) } }
    toLocalAbs(lng, lat) {
      const a = this.anchor
      return [(lng - a.lng) * a.mx, (lat - a.lat) * M_LAT]
    }
    originOffset() {
      const a = this.anchor
      return [(this.view.cx - a.lng) * a.mx, (this.view.cy - a.lat) * M_LAT]
    }

    /** Land use, water, parks and the road network — the coloured ground. */
    setBasemap(areas, roads) {
      const prep = list => list.map(f => {
        const pts = f.p.map(([lng, lat]) => this.toLocalAbs(lng, lat))
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [x, y] of pts) {
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
        }
        return { cls: f.c, n: f.n, pts, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
          radius: Math.hypot(maxX - minX, maxY - minY) / 2 }
      })
      this.areas = prep(areas || [])
      this.roads = prep(roads || [])
    }

    setPois(list) { this.pois = list }
    /** Named things that get drawn with an icon and a caption. */
    setLabels(list) { this.labelPoints = list || [] }
    setMarkers(list) { this.markers = list }
    setRings(list) { this.rings = list }

    draw(theme) {
      if (!this.W || !this.H) return
      const ctx = this.ctx
      const cam = this.camera()
      const [ox, oy] = this.anchor ? this.originOffset() : [0, 0]
      ctx.fillStyle = theme.bg
      ctx.fillRect(0, 0, this.W, this.H)
      if (this.areas.length || this.roads.length) this.drawBasemap(ctx, cam, ox, oy, theme)
      else this.drawGround(ctx, cam, theme)

      // ── buildings, far to near ──
      const cut = this.view.dist * 2.2
      const minH = this.quality === 'fast' ? 14 : 0
      const visible = []
      for (const b of this.buildings) {
        if (b.h < minH) continue
        const x = b.cx - ox, y = b.cy - oy
        if (Math.hypot(x, y) > cut) continue
        const c = this.project(cam, x, y, b.h / 2)
        if (!c) continue
        visible.push({ b, depth: c[2], x, y })
      }
      visible.sort((p, q) => q.depth - p.depth)

      for (const { b, x, y } of visible) {
        const base = [], top = []
        let ok = true
        for (const p of b.pts) {
          const px = p[0] - ox, py = p[1] - oy
          const a = this.project(cam, px, py, 0)
          const t = this.project(cam, px, py, b.h)
          if (!a || !t) { ok = false; break }
          base.push(a); top.push(t)
        }
        if (!ok || base.length < 3) continue
        const lit = b.h >= 100 ? theme.tallTop : b.k ? theme.knownTop : theme.guessTop
        const wall = b.h >= 100 ? theme.tallWall : b.k ? theme.knownWall : theme.guessWall
        // Each wall quad gets its own path. Putting them all in one path and
        // filling once looks like an optimisation, but the front and back faces
        // of a prism wind in opposite directions, so the nonzero fill rule
        // cancels them against each other and the building renders as a flat
        // plate with no sides. Their union is exactly the silhouette we want.
        ctx.fillStyle = wall
        for (let i = 0; i < base.length; i += 1) {
          const j = (i + 1) % base.length
          const ax = base[j][0] - base[i][0], ay = base[j][1] - base[i][1]
          const bx = top[i][0] - base[i][0], by = top[i][1] - base[i][1]
          if (Math.abs(ax * by - ay * bx) < 1.2) continue   // edge-on, nothing to see
          ctx.beginPath()
          ctx.moveTo(base[i][0], base[i][1])
          ctx.lineTo(base[j][0], base[j][1])
          ctx.lineTo(top[j][0], top[j][1])
          ctx.lineTo(top[i][0], top[i][1])
          ctx.closePath()
          ctx.fill()
        }
        ctx.fillStyle = lit
        ctx.beginPath()
        ctx.moveTo(top[0][0], top[0][1])
        for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i][0], top[i][1])
        ctx.closePath()
        ctx.fill()
        if (this.quality === 'full') {
          ctx.strokeStyle = b.h >= 150 ? theme.tallEdge : theme.roofEdge
          ctx.lineWidth = b.h >= 150 ? 1.2 : 0.6
          ctx.stroke()
        }
      }

      this.drawRings(ctx, cam, ox, oy)
      this.drawPois(ctx, cam, ox, oy, theme)
      if (this.quality === 'full') {
        this.taken = []
        this.drawRoadLabels(ctx, cam, ox, oy, theme)
        this.drawPlaceLabels(ctx, cam, ox, oy, theme)
        this.drawBuildingLabels(ctx, cam, ox, oy, visible, theme)
      }
      this.drawMarkers(ctx, cam, ox, oy, theme)
    }

    /**
     * The coloured ground: land-use and water polygons, then the road network,
     * all projected onto z=0. Everything is culled by bounding circle and the
     * smallest classes drop out while the camera is moving.
     */
    drawBasemap(ctx, cam, ox, oy, theme) {
      const cut = this.view.dist * 2.4
      const fast = this.quality === 'fast'
      const minRadius = fast ? this.view.dist / 90 : 0

      for (const a of this.areas) {
        const fill = theme.area[a.cls]
        if (!fill) continue
        const x = a.cx - ox, y = a.cy - oy
        if (Math.hypot(x, y) - a.radius > cut) continue
        if (a.radius < minRadius) continue
        let started = false
        ctx.beginPath()
        for (const [px, py] of a.pts) {
          const s = this.project(cam, px - ox, py - oy, 0)
          if (!s) { started = false; break }
          if (!started) { ctx.moveTo(s[0], s[1]); started = true } else ctx.lineTo(s[0], s[1])
        }
        if (!started) continue
        ctx.closePath()
        ctx.fillStyle = fill
        ctx.fill()
      }

      // Casings first, then fills, so junctions read cleanly.
      for (const pass of ['casing', 'fill']) {
        for (const cls of theme.roadOrder) {
          const spec = theme.road[cls]
          if (!spec) continue
          if (fast && spec.minor) continue
          ctx.strokeStyle = pass === 'casing' ? spec.casing : spec.color
          ctx.lineWidth = Math.max(0.6, (pass === 'casing' ? spec.width + 1.6 : spec.width) * (2200 / Math.max(this.view.dist, 400)))
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.beginPath()
          for (const r of this.roads) {
            if (r.cls !== cls) continue
            const x = r.cx - ox, y = r.cy - oy
            if (Math.hypot(x, y) - r.radius > cut) continue
            let started = false
            for (const [px, py] of r.pts) {
              const s = this.project(cam, px - ox, py - oy, 0)
              if (!s) { started = false; continue }
              if (!started) { ctx.moveTo(s[0], s[1]); started = true } else ctx.lineTo(s[0], s[1])
            }
          }
          ctx.stroke()
        }
      }
    }

    drawGround(ctx, cam, theme) {
      const step = this.view.dist > 4000 ? 1000 : this.view.dist > 1500 ? 500 : 200
      const span = Math.ceil((this.view.dist * 2.4) / step)
      ctx.strokeStyle = theme.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = -span; i <= span; i += 1) {
        const a = this.project(cam, i * step, -span * step, 0)
        const b = this.project(cam, i * step, span * step, 0)
        if (a && b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]) }
        const c = this.project(cam, -span * step, i * step, 0)
        const d = this.project(cam, span * step, i * step, 0)
        if (c && d) { ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]) }
      }
      ctx.stroke()
    }

    drawRings(ctx, cam, ox, oy) {
      for (const ring of this.rings) {
        const x0 = ring.x - ox, y0 = ring.y - oy
        for (const radius of ring.radii) {
          ctx.beginPath()
          let started = false
          for (let a = 0; a <= 64; a += 1) {
            const t = (a / 64) * Math.PI * 2
            const p = this.project(cam, x0 + Math.cos(t) * radius, y0 + Math.sin(t) * radius, 1)
            if (!p) { started = false; continue }
            if (!started) { ctx.moveTo(p[0], p[1]); started = true } else ctx.lineTo(p[0], p[1])
          }
          ctx.strokeStyle = ring.color
          ctx.setLineDash([5, 5])
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    }

    drawPois(ctx, cam, ox, oy, theme) {
      const cut = this.view.dist * 2.0
      for (const layer of theme.poiOrder) {
        if (!this.layers[layer.key]) continue
        ctx.fillStyle = layer.color
        for (const p of this.pois) {
          if (p.layer !== layer.key) continue
          const x = p.x - ox, y = p.y - oy
          if (Math.hypot(x, y) > cut) continue
          const s = this.project(cam, x, y, 2)
          if (!s) continue
          const size = Math.max(1.4, layer.size * (900 / s[2]))
          ctx.fillRect(s[0] - size / 2, s[1] - size / 2, size, size)
        }
      }
    }

    drawMarkers(ctx, cam, ox, oy, theme) {
      const drawn = []
      for (const m of this.markers) {
        const x = m.x - ox, y = m.y - oy
        const foot = this.project(cam, x, y, 0)
        const head = this.project(cam, x, y, m.tall ? 130 : 70)
        if (!foot || !head) continue
        drawn.push({ m, foot, head, depth: foot[2] })
      }
      drawn.sort((a, b) => b.depth - a.depth)
      for (const { m, foot, head } of drawn) {
        ctx.strokeStyle = m.color
        ctx.lineWidth = m.selected ? 2.5 : 1.5
        ctx.beginPath(); ctx.moveTo(foot[0], foot[1]); ctx.lineTo(head[0], head[1]); ctx.stroke()
        ctx.beginPath(); ctx.ellipse(foot[0], foot[1], 5, 2.2, 0, 0, Math.PI * 2)
        ctx.fillStyle = theme.shadow; ctx.fill()
        const r = m.selected ? 13 : 11
        // Units get a square, locations a circle. Colour alone is not enough:
        // a 待定 location is amber too, and a shop for rent has to stay
        // recognisable as a shop after it is taken into the list.
        ctx.beginPath()
        if (m.unit || m.kind === 'listing') {
          const k = r * 0.92
          ctx.roundRect(head[0] - k, head[1] - k, k * 2, k * 2, 4)
        } else {
          ctx.arc(head[0], head[1], r, 0, Math.PI * 2)
        }
        ctx.fillStyle = m.color; ctx.fill()
        ctx.strokeStyle = m.selected ? theme.markerRingOn : theme.markerRing
        ctx.lineWidth = m.selected ? 3 : 1.6
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = `700 ${m.selected ? 11 : 10}px ui-monospace, monospace`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(String(m.label ?? ''), head[0], head[1])
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
        m._screen = head
      }
    }

    /** Reserve a screen box for a label; false when something already owns it. */
    claim(x, y, w, h) {
      const box = [x - w / 2 - 2, y - h / 2 - 2, x + w / 2 + 2, y + h / 2 + 2]
      for (const t of this.taken) {
        if (box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1]) return false
      }
      this.taken.push(box)
      return true
    }

    /**
     * Place labels: an icon dot plus the name, in priority order so malls and
     * stations survive the collision test and noodle shops drop out first.
     * How far down the priority list we go depends on the zoom.
     */
    drawPlaceLabels(ctx, cam, ox, oy, theme) {
      const d = this.view.dist
      const maxPri = d > 7000 ? 1 : d > 3500 ? 2 : d > 1600 ? 3 : d > 700 ? 4 : 5
      const cut = d * 1.5
      const cands = []
      for (const p of this.labelPoints) {
        if (p.pri > maxPri) continue
        const x = p.x - ox, y = p.y - oy
        if (Math.hypot(x, y) > cut) continue
        const s = this.project(cam, x, y, 3)
        if (!s || s[0] < -60 || s[1] < -20 || s[0] > this.W + 60 || s[1] > this.H + 20) continue
        cands.push({ p, s })
      }
      cands.sort((a, b) => a.p.pri - b.p.pri || a.s[2] - b.s[2])
      ctx.textBaseline = 'middle'
      let drawn = 0
      for (const { p, s } of cands) {
        if (drawn > 220) break
        const colour = theme.cat[p.cat] || theme.cat.place
        ctx.font = '11px -apple-system, "PingFang SC", sans-serif'
        const w = ctx.measureText(p.name).width
        if (!this.claim(s[0] + 9 + w / 2, s[1], w + 20, 15)) continue
        drawn += 1
        ctx.beginPath()
        ctx.arc(s[0], s[1], 4.5, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()
        ctx.strokeStyle = theme.labelHalo
        ctx.lineWidth = 1.4
        ctx.stroke()
        ctx.lineWidth = 3
        ctx.strokeStyle = theme.labelHalo
        ctx.strokeText(p.name, s[0] + 8, s[1])
        ctx.fillStyle = theme.labelText
        ctx.fillText(p.name, s[0] + 8, s[1])
      }
      ctx.textBaseline = 'alphabetic'
    }

    /** Street names, drawn along the road at the mid-point of its longest run. */
    drawRoadLabels(ctx, cam, ox, oy, theme) {
      const d = this.view.dist
      if (d > 9000) return
      const allow = d > 4500 ? ['expy'] : d > 2000 ? ['expy', 'major'] : ['expy', 'major', 'minor']
      const cut = d * 1.4
      ctx.font = '600 10px -apple-system, "PingFang SC", sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      for (const r of this.roads) {
        if (!r.cls || !allow.includes(r.cls) || !r.n) continue
        const x = r.cx - ox, y = r.cy - oy
        if (Math.hypot(x, y) > cut) continue
        let best = null
        for (let i = 0; i < r.pts.length - 1; i += 1) {
          const a = this.project(cam, r.pts[i][0] - ox, r.pts[i][1] - oy, 1)
          const b = this.project(cam, r.pts[i + 1][0] - ox, r.pts[i + 1][1] - oy, 1)
          if (!a || !b) continue
          const len = Math.hypot(b[0] - a[0], b[1] - a[1])
          if (!best || len > best.len) best = { a, b, len }
        }
        if (!best || best.len < ctx.measureText(r.n).width + 24) continue
        const mx = (best.a[0] + best.b[0]) / 2, my = (best.a[1] + best.b[1]) / 2
        if (mx < 0 || my < 0 || mx > this.W || my > this.H) continue
        const w = ctx.measureText(r.n).width
        if (!this.claim(mx, my, w + 12, 14)) continue
        let angle = Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0])
        if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI
        ctx.save()
        ctx.translate(mx, my)
        ctx.rotate(angle)
        ctx.lineWidth = 3
        ctx.strokeStyle = theme.labelHalo
        ctx.strokeText(r.n, 0, 0)
        ctx.fillStyle = theme.roadLabel
        ctx.fillText(r.n, 0, 0)
        ctx.restore()
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    }

    drawBuildingLabels(ctx, cam, ox, oy, visible, theme) {
      let shown = 0
      for (const { b, x, y } of visible.slice().reverse()) {
        if (shown >= 6 || !b.n || b.h < 150) continue
        const p = this.project(cam, x, y, b.h + 12)
        if (!p) continue
        ctx.font = '10px -apple-system, "PingFang SC", sans-serif'
        const text = `${b.n} ${Math.round(b.h)}m`
        const w = ctx.measureText(text).width
        ctx.fillStyle = theme.labelBg
        ctx.fillRect(p[0] - w / 2 - 5, p[1] - 15, w + 10, 15)
        ctx.fillStyle = theme.labelText
        ctx.textAlign = 'center'
        ctx.fillText(text, p[0], p[1] - 4)
        ctx.textAlign = 'left'
        shown += 1
      }
    }

    /** Nearest marker to a screen pixel, for click selection. */
    hitMarker(px, py) {
      let best = null
      for (const m of this.markers) {
        if (!m._screen) continue
        const d = Math.hypot(m._screen[0] - px, m._screen[1] - py)
        if (d < 16 && (!best || d < best.d)) best = { d, marker: m }
      }
      return best?.marker || null
    }
  }

  window.Map3D = Map3D
})()
