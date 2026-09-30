window.__ModuleLoader__.load({ id: 'dsh-site-selection', factory: (require) => {
  const module = { exports: {} }
  const React = require('react')
  const h = React.createElement
  const RUNTIME_WORKBENCH_ID = 'wb-dataelement-dsh-site-selection'
  const LEGACY_WORKBENCH_ID = 'site-selection'

  const css = `
  .ss-panel{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;min-width:0;
    background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#17191c);
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  .ss-head{background-color:#fafaf8}
  @media (prefers-color-scheme:dark){ .ss-head{background-color:#25292b} }
  .ss-head{height:48px;flex:none;display:flex;align-items:center;gap:7px;padding:0 10px;
    border-bottom:1px solid var(--dsw-alias-border-l1,#dfe1e4)}
  .ss-head strong{font-size:12px;font-weight:600;padding:6px 2px}
  .ss-spacer{margin-left:auto;align-self:stretch}

  .ss-picker{position:relative;min-width:0;flex:1 1 auto;max-width:320px}
  .ss-picker-btn{width:100%;height:34px;display:flex;align-items:center;gap:7px;padding:0 9px;
    border:1px solid var(--dsw-alias-border-l1,#dfe1e4);border-radius:9px;
    background:var(--dsw-alias-bg-base,#fff);cursor:pointer;text-align:left}
  .ss-picker-btn:hover{border-color:var(--dsw-alias-label-secondary,#8a8e91)}
  .ss-picker-btn[data-open="true"]{border-color:#3f7d6f;box-shadow:0 0 0 3px rgba(63,125,111,.13)}
  .ss-picker-btn b{min-width:0;flex:1;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ss-picker-btn small{flex:none;color:var(--dsw-alias-label-secondary,#8a8e91);font-size:10px}
    /* The caret was 10px of text and read as decoration rather than as the
     control it is. Give it a real box so the whole affordance is visible. */
  .ss-picker-btn i{flex:none;font-style:normal;width:20px;height:20px;margin-right:-2px;
    display:flex;align-items:center;justify-content:center;border-radius:5px;
    color:var(--dsw-alias-label-secondary,#8a8e91);font-size:13px;line-height:1}
  .ss-picker-btn:hover i{background:var(--dsw-alias-interactive-bg-hover,#eef1f0);
    color:var(--dsw-alias-label-primary,#17191c)}
  .ss-menu{position:absolute;z-index:9;left:0;top:38px;width:max(300px,100%);max-height:60vh;overflow:auto;
    padding:5px;border:1px solid var(--dsw-alias-border-l1,#dfe1e4);border-radius:11px;
    background-color:#fff;box-shadow:0 10px 34px rgba(20,24,28,.2)}
  @media (prefers-color-scheme:dark){ .ss-menu{background-color:#1d2022} }
  .ss-menu-item{width:100%;min-height:46px;display:flex;align-items:center;gap:9px;padding:7px 9px;
    border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-align:left}
  .ss-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f2f3)}
  .ss-menu-item[data-current="true"]{background:rgba(63,125,111,.11)}
  .ss-menu-item .col{min-width:0;flex:1}
  .ss-menu-item b{display:block;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ss-menu-item small{display:block;margin-top:2px;color:var(--dsw-alias-label-secondary,#8a8e91);font-size:10px}
  .ss-menu-item .tick{flex:none;color:#3f7d6f;font-size:13px}
  .ss-row-acts{flex:none;display:flex;gap:2px;opacity:0}
  .ss-menu-item:hover .ss-row-acts,.ss-menu-item:focus-within .ss-row-acts{opacity:1}
  .ss-row-acts span{width:26px;height:26px;display:grid;place-items:center;border-radius:6px;
    color:var(--dsw-alias-label-secondary,#8a8e91);font-size:12px;cursor:pointer}
  .ss-row-acts span:hover{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#17191c)}
  .ss-row-acts span[data-danger="true"]:hover{background:rgba(168,69,60,.12);color:#a8453c}
  .ss-menu-sep{margin:5px 4px;border-top:1px solid var(--dsw-alias-border-l1,#dfe1e4)}
  .ss-menu-empty{padding:14px 10px;color:var(--dsw-alias-label-secondary,#8a8e91);font-size:11px;text-align:center;line-height:1.7}

  .ss-icon{width:32px;height:32px;flex:none;border:1px solid transparent;border-radius:8px;background:transparent;
    color:var(--dsw-alias-label-secondary,#6f7578);font-size:14px;line-height:1;cursor:pointer}
  .ss-icon:hover{border-color:var(--dsw-alias-border-l1,#dfe1e4);background:var(--dsw-alias-bg-base,#fff)}
  .ss-frame{flex:1;width:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base,#fff)}
  .ss-empty{flex:1;display:grid;place-items:center;padding:24px;text-align:center;
    color:var(--dsw-alias-label-secondary,#6f7578);font-size:12px;line-height:1.8}
  .ss-ask{position:absolute;inset:0;z-index:8;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:24px}
  .ss-ask-card{width:min(420px,100%);padding:16px;border:1px solid var(--dsw-alias-border-l1,#dfe1e4);border-radius:11px;
    background-color:#fff}
  @media (prefers-color-scheme:dark){ .ss-ask-card{background-color:#1d2022} }
  .ss-ask-card h3{margin:0 0 5px;font-size:13px}
  .ss-ask-card p{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#6f7578);font-size:11px;line-height:1.6}
  .ss-ask-card input{width:100%;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,#dfe1e4);
    border-radius:7px;background:transparent;font-size:12px;outline:0}
  .ss-ask-card input:focus{border-color:var(--dsw-alias-accent,#3f7d6f)}
  .ss-ask-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}
  .ss-ask-grid label{display:block;min-width:0}
  .ss-ask-grid span{display:block;margin-bottom:3px;color:var(--dsw-alias-label-secondary,#6f7578);font-size:10px}
  .ss-ask-grid select,.ss-ask-grid input{width:100%;height:30px;padding:0 8px;
    border:1px solid var(--dsw-alias-border-l1,#dfe1e4);border-radius:7px;background:transparent;font-size:11px}
  .ss-ask-grid input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a3)}
  /* The brand field takes free text, so it needs the full width for a hint that
     actually explains what to type. */
  .ss-ask-grid label.ss-ask-wide{grid-column:1 / -1}
  .ss-ask-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:11px}
  .ss-ask-actions button{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#dfe1e4);border-radius:7px;
    background:transparent;font-size:11px;cursor:pointer}
  .ss-ask-actions button[data-primary="true"]{border-color:#3f7d6f;background:#3f7d6f;color:#fff;font-weight:600}
  .ss-toast{position:absolute;z-index:60;left:50%;bottom:22px;transform:translate(-50%,10px);max-width:70vw;
    padding:9px 14px;border:1px solid var(--dsw-alias-border-l1,#dfe1e4);border-radius:8px;
    background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#17191c);font-size:12px;
    box-shadow:0 6px 24px rgba(20,24,28,.16);opacity:0;pointer-events:none;transition:.18s}
  .ss-toast[data-show="true"]{opacity:1;transform:translate(-50%,0)}`

  let bridge = null
  const listeners = new Set()
  let openState = { project: null, sessionId: null, message: '' }
  let projectIndex = []
  let sessionProjects = {}
  const LAST_PROJECT_KEY = 'dsh.site-selection.last-project.v1'
  const readLastProject = () => { try { return localStorage.getItem(LAST_PROJECT_KEY) || null } catch { return null } }
  let lastProject = readLastProject()
  function rememberProject(project) {
    lastProject = project
    try { if (project) localStorage.setItem(LAST_PROJECT_KEY, project); else localStorage.removeItem(LAST_PROJECT_KEY) } catch {}
  }
  const emit = () => listeners.forEach(fn => fn())
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }
  function setOpen(next) { openState = { ...openState, ...next }; emit() }
  function toast(message) { setOpen({ message }) }
  const currentSession = () => bridge?.sessions.list.getSnapshot().current || null
  function workbenchIsActive() {
    const service = bridge?.desktopWorkbenches
    if (typeof service?.isActive === 'function') return service.isActive()
    const state = service?.state
    return [RUNTIME_WORKBENCH_ID, LEGACY_WORKBENCH_ID].some(id => state?.active === id && state.added?.includes(id))
  }
  function workbenchOwnsSession(sessionId) {
    if (!sessionId) return false
    const service = bridge?.desktopWorkbenches
    if (typeof service?.ownsSession === 'function') return service.ownsSession(sessionId)
    const state = service?.state
    return workbenchIsActive() && [RUNTIME_WORKBENCH_ID, LEGACY_WORKBENCH_ID].includes(state?.sessionBindings?.[sessionId])
  }
  function ownedSession() {
    const id = currentSession()
    return workbenchOwnsSession(id) ? id : null
  }
  function followSession() {
    const id = ownedSession()
    if (!id && !workbenchIsActive()) return
    const known = id && Object.prototype.hasOwnProperty.call(sessionProjects, id)
    const project = known ? sessionProjects[id] : lastProject
    setOpen({ sessionId: id, project, message: '' })
    flushInitialDraft()
    if (id && !known && project) {
      // Associate the business selection already on screen with the new session.
      // Existing session mappings always win, including after reload.
      sessionProjects[id] = project
      void request('/api/site-selection/session-projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id, project }),
      }).catch(error => {
        if (sessionProjects[id] === project) delete sessionProjects[id]
        toast(`项目关联尚未保存，请重新选择项目：${error.message}`)
      })
    }
  }
  function businessMessage(event, frame, sessionId, project) {
    return workbenchIsActive() &&
      event.origin === window.location.origin && event.source === frame?.contentWindow &&
      openState.sessionId === sessionId && openState.project === project &&
      !!project && event.data?.project === project
  }
  function acceptedMessage(event, frame, sessionId, project) {
    return !!sessionId && ownedSession() === sessionId && businessMessage(event, frame, sessionId, project)
  }
  async function request(path, options) {
    const response = await fetch(path, options)
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
    return result
  }
  const projectUrl = (path, slug) => `${path}?project=${encodeURIComponent(slug)}`
  const bootstrap = slug => request(projectUrl('/api/site-selection/bootstrap', slug))

  function fillDraft(sessionId, prompt) {
    if (!sessionId || ownedSession() !== sessionId) throw new Error('会话已切换，请在当前工作台重新操作')
    const actx = bridge.sessions.scope?.(sessionId)
    const conversation = actx?.get?.('conversation')
    if (!conversation) throw new Error('对话输入不可用')
    const input = conversation.input.for(actx)
    const snapshot = input.state.getSnapshot()
    if (snapshot.occurrences?.length || (snapshot.phase && snapshot.phase !== 'plain')) throw new Error('当前草稿含引用或特殊输入，请先在原生会话中处理后再添加选址内容')
    const current = snapshot.draft || ''
    input.setDraft(current.trim() ? `${current}\n\n${prompt}` : prompt)
  }

  const onboarding = result => [
    '（按回车发送这段话，DSH 才会读到这个项目）', '',
    '你正在协助我使用「门店选址工作台」。',
    `项目：${result.state?.project?.name || ''}　项目文件夹：${result.folder}`,
    `先读 ${result.folder}/CONTEXT.md——它写明了 project.json 的结构、你可以改什么、以及不能改什么。`,
    '分工：你负责机械劳动（解析铺源、补全字段、交叉比对、生成材料）；踩点实感和签不签由我决定，你不要写 decision。',
    '改完 project.json 界面会自动刷新。', '',
    '先帮我选 10 个比较好的开店位置，顺便把每个位置附近在租的好铺也一起找出来。',
    '念给我听，我认可了再写进清单。',
    '业务项目不改变当前 DSH 工作区，文件操作仍遵循当前会话权限。'
  ].join('\n')
  const INITIAL_DRAFT_KEY = 'dsh.site-selection.initial-drafts.v1'
  let initialDrafts = { prompts: Object.create(null), delivered: Object.create(null) }
  try {
    const saved = JSON.parse(localStorage.getItem(INITIAL_DRAFT_KEY) || 'null')
    if (saved?.prompts && saved?.delivered) initialDrafts = { prompts: Object.assign(Object.create(null), saved.prompts), delivered: Object.assign(Object.create(null), saved.delivered) }
  } catch {}
  let deliveringInitial = false
  let projectAction = 0
  const persistInitialDrafts = () => { try { localStorage.setItem(INITIAL_DRAFT_KEY, JSON.stringify(initialDrafts)) } catch {} }
  function queueInitialDraft(project, result) {
    initialDrafts.prompts[project] = onboarding(result)
    persistInitialDrafts()
  }
  function flushInitialDraft() {
    if (deliveringInitial) return false
    const sessionId = ownedSession()
    const project = openState.project
    if (!sessionId || !project || !initialDrafts.prompts[project]) return false
    const delivery = JSON.stringify([sessionId, project])
    if (initialDrafts.delivered[delivery]) return false
    deliveringInitial = true
    try {
      fillDraft(sessionId, initialDrafts.prompts[project])
      initialDrafts.delivered[delivery] = true
      persistInitialDrafts()
      return true
    } catch {
      // Input readiness, rich references, or an in-flight submission can defer
      // delivery. Keep the durable request until this same context is ready.
      return false
    } finally { deliveringInitial = false }
  }
  async function openProject(slug, { createSession = false } = {}) {
    const ticket = ++projectAction
    const sessionId = ownedSession()
    const result = await bootstrap(slug)
    queueInitialDraft(slug, result)
    if (createSession) {
      if (ticket !== projectAction || !workbenchIsActive()) return
      // A new business project starts its own conversation. The queued prompt
      // survives a missing Desktop service or a composer that is not ready yet.
      rememberProject(slug)
      setOpen({ project: slug, sessionId: null, message: '' })
      try {
        const service = bridge?.desktopWorkbenches
        if (typeof service?.ensureSession !== 'function') throw new Error('当前 Desktop 版本不支持自动创建工作台会话')
        const id = await service.ensureSession({ folder: result.folder })
        if (ticket !== projectAction || !workbenchIsActive() || ownedSession() !== id) return
        await request('/api/site-selection/session-projects', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: id, project: slug }),
        })
        sessionProjects[id] = slug
        if (ticket === projectAction && ownedSession() === id) {
          setOpen({ project: slug, sessionId: id, message: '' })
          flushInitialDraft()
        }
      } catch (error) {
        if (ticket === projectAction && workbenchIsActive()) toast(`项目已创建，自动打开会话失败：${error.message}`)
      }
      return
    }
    if (!sessionId) {
      if (ticket !== projectAction || ownedSession() || !workbenchIsActive()) return
      rememberProject(slug)
      setOpen({ project: slug, sessionId: null, message: '' })
      return
    }
    await request('/api/site-selection/session-projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, project: slug }),
    })
    sessionProjects[sessionId] = slug
    if (ticket === projectAction && ownedSession() === sessionId) {
      rememberProject(slug)
      setOpen({ project: slug, sessionId, message: '' })
      flushInitialDraft()
    }
  }

  /** Assemble what the conversation needs to act on the current selection. */
  function askPrompt(detail, result) {
    const state = result.state
    const site = detail?.site
    const asks = {
      parse: '下面是中介/房东发来的铺源信息。请解析成结构化的候选点位，按 CONTEXT.md 的字段要求追加到 project.json 的 sites 数组里。'
        + '能确定的字段才填，不确定的填 null——尤其是坐标和排烟条件，不要猜。解析完在 activity 里说明你加了几个、哪些字段缺失需要我补。',
      brief: '为当前选中的点位生成一页上会材料初稿：区位结论、数据依据、风险提示、待确认事项。先写在对话里给我看，我确认后再落到 exports/。',
      compare: '对比工作台当前勾选的这几个点位，指出它们的关键差异和各自的主要风险。只给判断，不要改文件。',
      research: '查一下这个点位所在位置的公开信息：周边在建项目、地铁规划、临近的大型客流源（写字楼/学校/医院/景点）、以及餐饮相关的地方性限制。工作台只有 OpenStreetMap 的静态数据，看不到这些——这正是需要你补的部分。把你能确认的写进对话，不确定的标明。',
      free: '结合当前选中的点位回答我下面的问题。',
      find: '我要找点位。把我的要求翻译成 query-sites.mjs 的 --where 表达式去查，**不要靠网页搜索猜坐标**。'
        + '先跑 `--fields` 看清楚有哪些字段、以及哪些东西数据里根本没有；'
        + '如果我的要求里有数据查不到的（比如实测人流量、商场档次、租金），直接告诉我数据里没有，'
        + '用代理指标时要说明是代理——不要拿一段分析糊过去。'
        + '查完先把结果念给我听，我认可之后再加 --write 写进 project.json。'
        + '一条都查不到就放宽条件再试，并说明你放宽了哪一条。',
    }
    // The prompt opens with where we are. This array was referenced but never
    // declared, so every 交给 DSH button failed with "lines is not defined".
    const p = state.project || {}
    const lines = [
      `项目：${p.name || ''}${p.city ? `（${p.city}）` : ''}${p.referenceBrand ? `　参照品牌：${p.referenceBrand}` : ''}`,
      `项目文件夹：${result.folder || ''}`,
    ]
    // Without a selection there is still plenty worth sending: the baseline, the
    // saved sites and their scores. "Find me 80+ spots" must be answerable with
    // nothing selected — requiring a click first was the whole complaint.
    if (!site) {
      const saved = state.sites || []
      lines.push('', `已保存点位：${saved.length} 个`)
      for (const row of saved.slice(0, 25)) {
        lines.push(`  - ${row.name}（${row.id}）${Number.isFinite(row.lng) ? ` ${row.lng}, ${row.lat}` : ' ⚠ 缺坐标'}　状态 ${row.status}`)
      }
      if (!saved.length) lines.push('  （还没有保存任何点位）')
    }
    if (site) {
      const sc = detail.score || {}
      const f = sc.features || {}
      lines.push('', `当前选中：${site.name}（${site.id}）　${site.address || ''}`,
        `坐标 ${site.lng ?? '—'}, ${site.lat ?? '—'}`,
        `面积 ${site.area ?? '—'} ㎡　月租 ${site.rent ?? '—'} 元　临街面宽 ${site.frontage ?? '—'} m　楼层 ${site.floor ?? '—'}`,
        `商圈类型 ${f.districtType ?? '—'}　综合评分 ${sc.score ?? '—'}`)
      lines.push(`周边：最近地铁 ${f.metroDist ?? '—'}m　500m 建筑面积 ${Number.isFinite(f.floorArea500) ? `${(f.floorArea500 / 1e4).toFixed(1)} 万㎡` : '无数据'}　500m 餐饮 ${f.food500 ?? '—'} 家　500m 咖啡 ${f.cafe500 ?? '—'} 家　最近商场 ${f.mallDist ?? '—'}m`)
      if (sc.metrics?.length) {
        lines.push('各项百分位（对比参照品牌现有门店）：')
        for (const m of sc.metrics) lines.push(`  - ${m.label}：${m.value} ${m.unit} → 第 ${m.percentile} 百分位`)
      }
      if (sc.flags?.length) lines.push(`风险提示：${sc.flags.map(x => x.text).join('；')}`)
      if (sc.exclusions?.length) lines.push(`硬性排除：${sc.exclusions.map(e => e.text).join('；')}`)
      if (sc.conflicts?.length) lines.push(`矛盾信号：${sc.conflicts.map(c => c.text).join('；')}`)
      if (sc.rentFlag) lines.push(`租金提示：${sc.rentFlag.text}`)
      if (site.fieldNotes?.length) {
        lines.push('我的踩点记录：')
        for (const n of site.fieldNotes) lines.push(`  - 高峰 ${n.peakFlow ?? '—'} 人/时，平峰 ${n.offpeakFlow ?? '—'} 人/时。${n.observation}`)
      }
    }
    if (detail?.payload) lines.push('', '--- 待处理内容 ---', String(detail.payload).slice(0, 6000), '--- 内容结束 ---')
    return [...lines, '', asks[detail?.mode] || asks.free, detail?.request ? `我的要求：${detail.request}` : ''].filter(Boolean).join('\n')
  }

  // ── components ───────────────────────────────────────────
  function Panel() {
    const [state, setState] = React.useState(openState)
    const [projects, setProjects] = React.useState([])
    const frames = React.useRef(new Map())
    const frameKey = `${state.sessionId}:${state.project}`
    if (state.project && !frames.current.has(frameKey)) frames.current.set(frameKey, { project: state.project, node: null })
    // window.prompt() is not implemented in Electron — it returns without showing
    // anything, which silently dead-ended both create buttons. Ask in-panel instead.
    const [ask, setAsk] = React.useState(null)
    const [menuOpen, setMenuOpen] = React.useState(false)
    const [rename, setRename] = React.useState(null)
    const [confirmDel, setConfirmDel] = React.useState(null)
    const [catalog, setCatalog] = React.useState([])
    const [samples, setSamples] = React.useState([])
    const [formats, setFormats] = React.useState([])
    React.useEffect(() => {
      request('/api/site-selection/datasets')
        .then(r => { setCatalog(r.datasets); setSamples(r.samples || []); setFormats(r.formats || []) })
        .catch(() => {})
    }, [])

    React.useEffect(() => subscribe(() => setState({ ...openState })), [])

    const reload = React.useCallback(() => {
      request('/api/site-selection/projects')
        .then(r => {
          setProjects(r.projects)
          projectIndex = r.projects
          if (lastProject && !r.projects.some(row => row.id === lastProject)) rememberProject(null)
          if (openState.project && !r.projects.some(row => row.id === openState.project)) setOpen({ project: null })
        })
        .catch(e => toast(e.message))
    }, [])
    React.useEffect(() => { reload() }, [state.sessionId, reload])

    // Any click outside the menu closes it, including inside the workbench iframe.
    React.useEffect(() => {
      if (!menuOpen) return undefined
      const close = () => setMenuOpen(false)
      document.addEventListener('click', close)
      window.addEventListener('blur', close)
      return () => { document.removeEventListener('click', close); window.removeEventListener('blur', close) }
    }, [menuOpen])

    const current = projects.find(row => row.id === state.project) || null

    React.useEffect(() => {
      const onMessage = async event => {
        const sessionId = state.sessionId, project = state.project
        if (!businessMessage(event, frames.current.get(`${sessionId}:${project}`)?.node, sessionId, project)) return
        const data = event.data
        if (data?.type === 'dsh-site-selection:ask') {
          if (!sessionId || ownedSession() !== sessionId) {
            const error = '可直接使用选址功能；交给 Agent 时，请在会话区选择工作区并创建本工作台会话'
            event.source.postMessage({ type: 'dsh-site-selection:ask-result', ok: false, error }, event.origin)
            toast(error)
            return
          }
          try {
            const result = await bootstrap(project)
            // The async load must not deliver a previous project's prompt after navigation.
            if (!acceptedMessage(event, frames.current.get(`${sessionId}:${project}`)?.node, sessionId, project)) return
            fillDraft(sessionId, askPrompt(data, result))
            event.source.postMessage({ type: 'dsh-site-selection:ask-result', ok: true }, event.origin)
          } catch (error) {
            if (!acceptedMessage(event, frames.current.get(`${sessionId}:${project}`)?.node, sessionId, project)) return
            event.source.postMessage({ type: 'dsh-site-selection:ask-result', ok: false, error: error.message }, event.origin)
            toast(error.message)
          }
        }
        if (data?.type === 'dsh-site-selection:projects-changed') reload()
        if (data?.type === 'dsh-site-selection:whoami') event.source.postMessage({
          type: 'dsh-site-selection:bound', ok: !!sessionId,
          detail: sessionId ? `当前会话 ${sessionId.slice(0, 8)}… · 选址项目独立于 DSH 工作区；交给 DSH 会追加到草稿，确认后发送。` : '可以直接浏览、创建和编辑选址项目；交给 Agent 时，再在会话区创建会话。',
        }, event.origin)
      }
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    }, [reload, state.sessionId, state.project])

    const submitCreate = async () => {
      const name = String(ask.value || '').trim()
      if (!name) return
      const { sample, dataset, format, referenceBrand } = ask
      setAsk(null)
      try {
        const result = await request('/api/site-selection/projects', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, sample: sample || false, dataset, format, referenceBrand }),
        })
        reload()
        await openProject(result.project.id, { createSession: true })
      } catch (error) { toast(`创建失败：${error.message}`) }
    }

    return h('section', { className: 'ss-panel' },
      h('header', { className: 'ss-head' },
        h('strong', null, '选址工作台'),
        // A real dropdown rather than a 26px native <select>: the row is the hit
        // target, and creating a project lives in the same menu instead of
        // behind two more small icons.
        h('div', { className: 'ss-picker' },
          h('button', {
            className: 'ss-picker-btn', type: 'button', 'data-open': String(menuOpen),
            title: '切换项目',
            onClick: e => { e.stopPropagation(); setMenuOpen(!menuOpen); if (!menuOpen) reload() },
          },
            h('b', null, current ? current.name : (projects.length ? '选择项目…' : '还没有项目')),
            current ? h('small', null, `${current.sites} 个点位`) : null,
            h('i', null, menuOpen ? '▴' : '▾')),
          menuOpen ? h('div', { className: 'ss-menu', onClick: e => e.stopPropagation() },
            projects.length
              ? projects.map(row => h('button', {
                  key: row.id, className: 'ss-menu-item', type: 'button',
                  'data-current': String(row.id === state.project),
                  onClick: () => {
                    setMenuOpen(false)
                    openProject(row.id).catch(err => toast(err.message))
                  },
                },
                  h('span', { className: 'col' },
                    h('b', null, row.name),
                    h('small', null, `${row.city || '未设城市'} · ${row.statusLabel}${row.referenceBrand ? ` · 参照 ${row.referenceBrand}` : ''}`)),
                  h('span', { className: 'ss-row-acts' },
                    h('span', {
                      title: '重命名', role: 'button',
                      onClick: e => { e.stopPropagation(); setMenuOpen(false); setRename({ id: row.id, value: row.name }) },
                    }, '✎'),
                    h('span', {
                      title: '删除项目', role: 'button', 'data-danger': 'true',
                      onClick: e => { e.stopPropagation(); setMenuOpen(false); setConfirmDel(row) },
                    }, '🗑')),
                  row.id === state.project ? h('span', { className: 'tick' }, '✓') : null))
              : h('div', { className: 'ss-menu-empty' }, '还没有项目。', h('br'), '用下面两项新建一个。'),
            h('div', { className: 'ss-menu-sep' }),
            h('button', {
              className: 'ss-menu-item', type: 'button',
              onClick: () => { setMenuOpen(false); setAsk({ sample: false, value: '',
                dataset: catalog[0]?.id || '', format: 'restaurant', referenceBrand: '' }) },
            }, h('span', { className: 'col' }, h('b', null, '＋ 新建项目'),
                h('small', null, '选城市数据集，参照品牌可留空'))),
            ...samples.map(sp => h('button', {
              key: sp.id, className: 'ss-menu-item', type: 'button',
              onClick: () => { setMenuOpen(false); setAsk({ sample: sp.id, value: sp.label }) },
            }, h('span', { className: 'col' }, h('b', null, `◇ 示例：${sp.label}`),
                h('small', null, sp.blurb))))) : null),
        h('button', { className: 'ss-icon', type: 'button', title: '刷新项目列表', onClick: reload }, '↻'),
        h('span', { className: 'ss-spacer' })),
      ...[...frames.current.entries()].map(([key, item]) => h('iframe', {
        ref: node => { item.node = node }, key, className: 'ss-frame', title: '选址工作台',
        style: { display: key === frameKey ? 'block' : 'none' },
        src: projectUrl('/api/site-selection/app', item.project),
      })),
      !state.project && h('div', { className: 'ss-empty' }, '从项目菜单新建或选择一个选址项目，即可开始使用。需要 Agent 帮助时，再在会话区创建会话。'),
      rename && h('div', { className: 'ss-ask', onMouseDown: e => { if (e.target === e.currentTarget) setRename(null) } },
        h('form', {
          className: 'ss-ask-card',
          onSubmit: async e => {
            e.preventDefault()
            const name = String(rename.value || '').trim()
            const id = rename.id
            setRename(null)
            if (!name) return
            try {
              await request('/api/site-selection/action', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ project: id, type: 'rename-project', name }),
              })
              reload()
              toast('已重命名')
            } catch (error) { toast(`重命名失败：${error.message}`) }
          },
        },
          h('h3', null, '重命名项目'),
          h('p', null, '只改显示名称，项目文件夹和会话的工作区都不动。'),
          h('input', {
            autoFocus: true, value: rename.value, placeholder: '项目名称',
            onChange: e => setRename(prev => ({ ...prev, value: e.target.value })),
            onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); setRename(null) } },
          }),
          h('div', { className: 'ss-ask-actions' },
            h('button', { type: 'button', onClick: () => setRename(null) }, '取消'),
            h('button', { type: 'submit', 'data-primary': 'true' }, '保存')))),

      confirmDel && h('div', { className: 'ss-ask', onMouseDown: e => { if (e.target === e.currentTarget) setConfirmDel(null) } },
        h('form', {
          className: 'ss-ask-card',
          onSubmit: async e => {
            e.preventDefault()
            const row = confirmDel
            setConfirmDel(null)
            try {
              await request('/api/site-selection/projects/delete', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ project: row.id }),
              })
              if (lastProject === row.id) rememberProject(null)
              if (state.project === row.id) setOpen({ project: null })
              reload()
              toast('项目已移入回收站')
            } catch (error) { toast(`删除失败：${error.message}`) }
          },
        },
          h('h3', null, `删除「${confirmDel.name}」？`),
          h('p', null, `这个项目有 ${confirmDel.sites} 个点位。不会真的删掉文件——`,
            '整个文件夹会移到数据目录下的 .trash/ 里，需要时可以手动找回。'),
          h('div', { className: 'ss-ask-actions' },
            h('button', { type: 'button', onClick: () => setConfirmDel(null) }, '取消'),
            h('button', { type: 'submit', 'data-primary': 'true', style: { background: '#a8453c', borderColor: '#a8453c' } }, '删除')))),

      ask && h('div', { className: 'ss-ask', onMouseDown: e => { if (e.target === e.currentTarget) setAsk(null) } },
        h('form', {
          className: 'ss-ask-card',
          onSubmit: e => { e.preventDefault(); submitCreate() },
        },
          h('h3', null, ask.sample ? '新建示例项目' : '新建选址项目'),
          h('p', null, ask.sample
            ? '会载入该城市的真实 POI、路网与三维建筑，以及一组用工作台自己的模型从真实商业地址里挑出来的候选点位。面积租金留空——那些要谈过才知道。'
            : '选城市和业态就能开始。业态决定「同类竞争」按什么算——开药店就跟药店比，不会拿咖啡店当竞品。'
              + '参照品牌留空即可，默认拿全区所有已有商业位置当基线。'),
          h('input', {
            autoFocus: true, value: ask.value, placeholder: '项目名称，例如「朝阳区开店」',
            onChange: e => setAsk(prev => ({ ...prev, value: e.target.value })),
            onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); setAsk(null) } },
          }),
          !ask.sample && catalog.length ? h('div', { className: 'ss-ask-grid' },
            h('label', null, h('span', null, '城市数据集'),
              h('select', {
                value: ask.dataset,
                onChange: e => {
                  const next = catalog.find(c => c.id === e.target.value)
                  setAsk(prev => ({ ...prev, dataset: e.target.value }))
                },
              }, ...catalog.map(c => h('option', { key: c.id, value: c.id },
                `${c.label}${c.simulated ? '（模拟数据）' : ''}`)))),
            h('label', null, h('span', null, '业态'),
              h('select', {
                value: ask.format,
                onChange: e => setAsk(prev => ({ ...prev, format: e.target.value })),
              }, ...formats.map(f => h('option', { key: f.id, value: f.id }, f.label)))),
            // Free text, not a list: the useful reference is usually a specific
            // chain the operator has in mind, and no fixed list will contain it.
            h('label', { className: 'ss-ask-wide' }, h('span', null, '参照品牌（可选）'),
              h('input', {
                type: 'text', value: ask.referenceBrand, list: 'ss-brand-hints',
                placeholder: '留空＝用全区基线；也可填「星巴克」「屈臣氏」等具体品牌',
                onChange: e => setAsk(prev => ({ ...prev, referenceBrand: e.target.value })),
              }),
              h('datalist', { id: 'ss-brand-hints' },
                ...(catalog.find(c => c.id === ask.dataset)?.brands || [])
                  .map(b => h('option', { key: b, value: b }))))) : null,
          h('div', { className: 'ss-ask-actions' },
            h('button', { type: 'button', onClick: () => setAsk(null) }, '取消'),
            h('button', { type: 'submit', 'data-primary': 'true' }, '创建')))),
      state.message && h('div', { className: 'ss-toast', 'data-show': 'true', role: 'status' }, state.message))
  }

  const inject = ['desktopWorkbenches', 'sessions', 'conversation']
  function apply(ctx) {
    bridge = ctx
    ctx.effect(() => {
      let live = true
      request('/api/site-selection/session-projects').then(r => {
        if (!live) return
        sessionProjects = r.bindings
        followSession()
      }).catch(error => { if (live) toast(error.message) })
      const sessionDispose = ctx.sessions.list.subscribe(followSession)
      const workbenchDispose = ctx.desktopWorkbenches.subscribe(followSession)
      return () => { live = false; sessionDispose(); workbenchDispose() }
    })
    ctx.effect(() => {
      const timer = setInterval(flushInitialDraft, 500)
      return () => clearInterval(timer)
    })
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.dshPlugin = 'dsh-site-selection'
      style.textContent = css
      document.head.appendChild(style)
      return () => style.remove()
    })
    ctx.effect(() => ctx.desktopWorkbenches.register({
      id: RUNTIME_WORKBENCH_ID, title: '门店选址', icon: '◎', panelTitle: '选址项目与地图',
      repository: 'https://github.com/dataelement/dsh-site-selection',
      description: '三维城市地图、点位评分、铺源比较与踩点记录。',
      audience: '门店拓展与选址团队', requirements: '使用原生会话模型及工具；地图数据随包提供。',
      initialization: 'empty', embedded: true, version: '1.2.1', author: 'DataElement', layout: { businessSide: 'left', businessWidth: 0.65 },
    }, Panel))
  }

  module.exports = { inject, apply, businessMessage, acceptedMessage, fillDraft, openProject, followSession, queueInitialDraft, flushInitialDraft,
    RUNTIME_WORKBENCH_ID, LEGACY_WORKBENCH_ID }
  return module.exports
} })
