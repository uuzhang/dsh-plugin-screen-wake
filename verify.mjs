/**
 * Offline harness for the screen-wake plugin.
 *
 * Simulates the Cordis plugin runtime: a fake `ctx` whose `on`/`get`/`logger`
 * behave like the real ones, plus a `subprocess` stub that records spawn specs.
 * This exercises the plugin's own logic — dispatch filtering, coalescing, and
 * the spawn spec shape — without a live Harness.
 */

import { apply, Config, inject } from 'file:///H:/AI/Deepseek/dsh-plugin-screen-wake/index.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---- 1. bundle identity ----------------------------------------------------
// The module must export exactly the plugin contract: apply + inject + Config.
// An extra `name` export is not part of that contract and made the loader report
// the row as `unsupported`, so its absence is asserted here.
const mod = await import('file:///H:/AI/Deepseek/dsh-plugin-screen-wake/index.js')
const exportKeys = Object.keys(mod).sort()
check(
  'exports exactly apply/inject/Config',
  JSON.stringify(exportKeys) === JSON.stringify(['Config', 'apply', 'inject']),
  JSON.stringify(exportKeys),
)
check(
  'declares webServer as a hard dependency',
  Array.isArray(inject) && inject.includes('webServer'),
  JSON.stringify(inject),
)
check(
  'Config uses Standard Schema',
  typeof Config['~standard']?.validate === 'function' && Config['~standard'].version === 1,
)

const validated = Config['~standard'].validate({})
check('validate fills defaults', validated.value?.onTurnEnd === true && !validated.issues)

// ---- 2. fake runtime -------------------------------------------------------
const listeners = []
const spawns = []
const logs = []
const routes = []
const effects = []

/** The web-server double a declared `webServer` dependency provides. */
function makeWebServer() {
  return {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

const fakeCtx = {
  logger: {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
  },
  webServer: makeWebServer(),
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  on(event, handler) {
    listeners.push({ event, handler })
  },
  get(service) {
    if (service !== 'subprocess') return undefined
    return {
      spawn(spec) {
        spawns.push(spec)
        const payload = JSON.stringify({ ok: true, locked: false, previous: '0x80000000' })
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: payload, nextOffset: payload.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
        }
      },
    }
  },
}

apply(fakeCtx, Config['~standard'].validate({}).value)

check('registered one listener', listeners.length === 1, `count=${listeners.length}`)
check('listens on session/event', listeners[0]?.event === 'session/event', listeners[0]?.event)
check('logged activation', logs.some((l) => l.includes('active')), logs.join(' | '))

const dispatch = (session, event) => listeners[0].handler(session, event)
const settle = () => new Promise((r) => setTimeout(r, 50))

const mainSession = { id: 's-main', header: { parentSession: undefined } }
const childSession = { id: 's-child', header: { parentSession: 's-main', origin: 'subagent' } }

// ---- 3. trigger behaviour --------------------------------------------------
dispatch(mainSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await settle()
check('turn/end wakes', spawns.length === 1, `spawns=${spawns.length}`)

// coalescing: a burst inside minIntervalMs must not spawn again
dispatch(mainSession, { type: 'tool/call', data: { name: 'ask_user_question' } })
await settle()
check('coalesced within minIntervalMs', spawns.length === 1, `spawns=${spawns.length}`)

// ---- 4. spawn spec shape ---------------------------------------------------
const spec = spawns[0] ?? {}
check('argv is an array', Array.isArray(spec.argv), typeof spec.argv)
check('argv[0] is powershell', spec.argv?.[0] === 'powershell.exe', spec.argv?.[0])
check('argv has -Command', spec.argv?.includes('-Command'))
check('argv has ExecutionPolicy Bypass', spec.argv?.includes('Bypass'))
check('cwd is a string', typeof spec.cwd === 'string' && spec.cwd.length > 0, spec.cwd)
check('stdin ignore', spec.stdio?.stdin === 'ignore', JSON.stringify(spec.stdio?.stdin))
check('stdout collect mode', typeof spec.stdio?.stdout?.maxBytes === 'number')
check('graceMs is a number', typeof spec.graceMs === 'number', String(spec.graceMs))
check('env carries the nudge flag', spec.env?.DSH_WAKE_NUDGE === '1', spec.env?.DSH_WAKE_NUDGE)
check(
  'script uses kernel32 for SetThreadExecutionState',
  spec.argv?.some((a) => typeof a === 'string' && a.includes('kernel32.dll')),
)
check(
  'script uses OpenInputDesktop for lock detection',
  spec.argv?.some((a) => typeof a === 'string' && a.includes('OpenInputDesktop')),
)

// ---- 5. subagent exclusion (needs a fresh plugin instance) -----------------
listeners.length = 0
spawns.length = 0
apply(fakeCtx, Config['~standard'].validate({ minIntervalMs: 0 }).value)
const dispatch2 = (session, event) => listeners[0].handler(session, event)

dispatch2(childSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await settle()
check('subagent parentSession is skipped', spawns.length === 0, `spawns=${spawns.length}`)

dispatch2({ id: 's2', header: { origin: 'subagent' } }, { type: 'turn/end', data: {} })
await settle()
check('origin=subagent is skipped', spawns.length === 0, `spawns=${spawns.length}`)

dispatch2({ id: 's3', header: { delegationDepth: 2 } }, { type: 'turn/end', data: {} })
await settle()
check('delegationDepth>0 is skipped', spawns.length === 0, `spawns=${spawns.length}`)

dispatch2({ id: 's4', header: {} }, { type: 'turn/end', data: {} })
await settle()
check('main session still wakes with minIntervalMs=0', spawns.length === 1, `spawns=${spawns.length}`)

// ---- 6. unrelated events are inert ----------------------------------------
spawns.length = 0
dispatch2({ id: 's5', header: {} }, { type: 'assistant/message', data: {} })
dispatch2({ id: 's5', header: {} }, { type: 'tool/call', data: { name: 'read' } })
await settle()
check('unrelated events do not wake', spawns.length === 0, `spawns=${spawns.length}`)

// ---- 7. a throwing subprocess must not break the session -------------------
listeners.length = 0
routes.length = 0
apply(
  {
    ...fakeCtx,
    webServer: makeWebServer(),
    get: () => ({
      spawn() {
        throw new Error('spawn boom')
      },
    }),
  },
  Config['~standard'].validate({}).value,
)
let threw = false
try {
  listeners[0].handler({ id: 's6', header: {} }, { type: 'turn/end', data: {} })
  await settle()
} catch {
  threw = true
}
check('a failing spawn never propagates to the session', !threw)

// ---- 8. missing subprocess service ----------------------------------------
listeners.length = 0
routes.length = 0
apply(
  { ...fakeCtx, webServer: makeWebServer(), get: () => undefined },
  Config['~standard'].validate({}).value,
)
let threw2 = false
try {
  listeners[0].handler({ id: 's7', header: {} }, { type: 'turn/end', data: {} })
  await settle()
} catch {
  threw2 = true
}
check('a missing subprocess service is tolerated', !threw2)

// Re-run section 9 against a fixture that has both services.
listeners.length = 0
routes.length = 0
spawns.length = 0
apply(fakeCtx, Config['~standard'].validate({}).value)

// ---- 9. routes -------------------------------------------------------------
check('registered both routes', routes.length === 2, `routes=${routes.length}`)
const offRoute = routes.find((r) => r.path === '/api/screen-wake/off')
const statusRoute = routes.find((r) => r.path === '/api/screen-wake/status')
check('off route is exact /api/screen-wake/off', offRoute?.kind === 'exact', `${offRoute?.kind} ${offRoute?.path}`)
check('status probe is exact /api/screen-wake/status', statusRoute?.kind === 'exact', `${statusRoute?.kind} ${statusRoute?.path}`)

/** Minimal IncomingMessage / ServerResponse doubles. */
function fakeReq(method) {
  return { method, url: '/api/screen-wake/off', headers: {} }
}
function fakeRes() {
  const out = { status: 0, headers: undefined, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(chunk) {
      out.body = chunk ?? ''
    },
  }
}

// The probe must answer without touching the display.
{
  const res = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res)
  check('status probe answers 200', res.out.status === 200, String(res.out.status))
  const body = JSON.parse(res.out.body)
  check('status probe reports the plugin', body.plugin === '@local/dsh-plugin-screen-wake', body.plugin)
  check('status probe carries a generation tag', typeof body.generation === 'number', String(body.generation))
  check('status probe spawned nothing', spawns.length === 0, `spawns=${spawns.length}`)
}

// A GET must be rejected: the endpoint has a side effect.
{
  const res = fakeRes()
  await offRoute.handler(fakeReq('GET'), res)
  check('GET is refused with 405', res.out.status === 405, String(res.out.status))
  check('rejection body says method-not-allowed', res.out.body.includes('method-not-allowed'), res.out.body)
}

// A POST runs the monitor-off program and reports success.
spawns.length = 0
{
  const res = fakeRes()
  await offRoute.handler(fakeReq('POST'), res)
  check('POST answers 200', res.out.status === 200, String(res.out.status))
  check('POST body is {ok:true}', res.out.body === '{"ok":true}', res.out.body)
  check('POST spawned one process', spawns.length === 1, `spawns=${spawns.length}`)
  const spec = spawns[0] ?? {}
  check(
    'monitor-off script uses SendMessageTimeout',
    spec.argv?.some((a) => typeof a === 'string' && a.includes('SendMessageTimeout')),
  )
  check(
    'monitor-off script uses SC_MONITORPOWER 0xF170',
    spec.argv?.some((a) => typeof a === 'string' && a.includes('0xF170')),
  )
  check(
    'monitor-off script passes MONITOR_OFF=2',
    spec.argv?.some((a) => typeof a === 'string' && a.includes('(IntPtr)2')),
  )
}

// A failing spawn must answer 500, not throw out of the handler.
listeners.length = 0
routes.length = 0
apply(
  {
    ...fakeCtx,
    webServer: makeWebServer(),
    get: () => ({ spawn() { throw new Error('boom') } }),
  },
  Config['~standard'].validate({}).value,
)
{
  const res = fakeRes()
  let threw3 = false
  const failingOff = routes.find((r) => r.path === '/api/screen-wake/off')
  try {
    await failingOff.handler(fakeReq('POST'), res)
  } catch {
    threw3 = true
  }
  check('a failing monitor-off does not throw out of the handler', !threw3)
  check('a failing monitor-off answers 500', res.out.status === 500, String(res.out.status))
  check('failure body is ok:false', res.out.body.includes('"ok":false'), res.out.body)
}

// ---- 10. dependency contract -----------------------------------------------
// `webServer` is a declared hard dependency, so Cordis never calls `apply`
// without it. The earlier "no web server" fallback branch is therefore gone by
// design; assert that the declaration is what makes that safe.
check(
  'webServer is declared so apply never runs without it',
  Array.isArray(inject) && inject.length === 1 && inject[0] === 'webServer',
  JSON.stringify(inject),
)
check(
  'apply registers exactly two routes when the dependency is present',
  routes.length === 2,
  `routes=${routes.length}`,
)

console.log('')
console.log(failures.length === 0 ? `ALL CHECKS PASSED` : `${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
