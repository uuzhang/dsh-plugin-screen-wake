/**
 * Screen Wake — keeps the monitor awake while DSH waits, and can switch it off on demand.
 *
 * Wake triggers (host-side):
 *   - a main session commits `turn/end`        -> the answer is complete, DSH is about to wait
 *   - a main session calls `ask_user_question` -> a choice prompt is about to appear
 *
 * Wake mechanism (Windows):
 *   1. SetThreadExecutionState(ES_CONTINUOUS|ES_DISPLAY_REQUIRED|ES_SYSTEM_REQUIRED)
 *      resets the display-idle timer, so it also dismisses an already-running screen saver.
 *   2. An optional one-pixel mouse nudge, for a screen saver that already owns the screen.
 *
 * Manual trigger (browser):
 *   - `POST /api/screen-wake/off` switches the monitor off, behind the sidebar button
 *     registered by the Client half in `sidebar.footer.action`.
 *
 * Subagent sessions are skipped: a session whose header carries `parentSession`,
 * `origin: 'subagent'`, or `delegationDepth` is delegated work, not something the
 * operator is waiting on.
 */

/** Tool calls that mean "DSH is now waiting for the operator's decision". */
const AWAIT_TOOL_NAMES = new Set(['ask_user_question'])

/** Exact HTTP route the sidebar button posts to. */
const MONITOR_OFF_PATH = '/api/screen-wake/off'

/** Read-only probe route; answers only when this module generation is loaded. */
const MONITOR_STATUS_PATH = '/api/screen-wake/status'

/** Identifies the loaded module generation, so a stale Host is detectable. */
const BUILD_TAG = 3

/**
 * PowerShell program that performs the wake and reports observable state.
 *
 * `SetThreadExecutionState` lives in kernel32.dll, NOT user32.dll — the common
 * mis-declaration fails with EntryPointNotFoundException.
 *
 * `OpenInputDesktop` is the reliable lock signal; `GetSystemMetrics(15)` is not
 * (it reports a stale screen-saver flag and cannot be trusted).
 */
const WAKE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class DshScreenWake {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint f);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")]
  public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")]
  public static extern bool CloseDesktop(IntPtr h);
  public static bool Locked() {
    IntPtr h = OpenInputDesktop(0, false, 0x0001);
    if (h == IntPtr.Zero) return true;
    CloseDesktop(h);
    return false;
  }
  public static uint KeepAwake() {
    return SetThreadExecutionState(0x80000000u | 0x00000002u | 0x00000001u);
  }
  public static void Release() { SetThreadExecutionState(0x80000000u); }
  public static void Nudge() {
    mouse_event(0x0001, 1, 0, 0, IntPtr.Zero);
    mouse_event(0x0001, -1, 0, 0, IntPtr.Zero);
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp | Out-Null
$locked = [DshScreenWake]::Locked()
$prev = [DshScreenWake]::KeepAwake()
if ($env:DSH_WAKE_NUDGE -eq '1') { [DshScreenWake]::Nudge() }
[DshScreenWake]::Release()
[pscustomobject]@{
  ok       = ($prev -ne 0xFFFFFFFF)
  locked   = $locked
  previous = ('0x{0:X}' -f $prev)
} | ConvertTo-Json -Compress
`

/**
 * PowerShell program that switches the monitor off.
 *
 * `WM_SYSCOMMAND` / `SC_MONITORPOWER` (0xF170) with `MONITOR_OFF` (2) is the
 * documented way to power down the display without suspending the machine.
 * Broadcast through `SendMessageTimeout` so an unresponsive window cannot hang
 * the call.
 */
const MONITOR_OFF_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class DshMonitorOff {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  public static bool Off() {
    IntPtr result;
    IntPtr ok = SendMessageTimeout((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2, 0x0002, 1000, out result);
    return ok != IntPtr.Zero;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp | Out-Null
$ok = [DshMonitorOff]::Off()
[pscustomobject]@{ ok = $ok } | ConvertTo-Json -Compress
`

/** Detect delegated work from a session's durable header. */
function isSubagentSession(session) {
  const header = session?.header
  if (!header) return true // no header: not a session we can reason about
  if (header.parentSession != null) return true
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * Schema for this row's `config`.
 *
 * A Host-only bundle declares no dependencies, so the harness's `schemastery`
 * helper is not importable here. Cordis consumes the Standard Schema interface
 * (`Config['~standard'].validate`), which this hand-rolled schema implements:
 * every field is optional, unknown fields are rejected, and defaults are filled
 * in so `apply` always receives a complete config.
 */
const CONFIG_FIELDS = {
  onTurnEnd: {
    type: 'boolean',
    default: true,
    description: 'Wake the monitor when a main session finishes a turn.',
  },
  onAwaitingUser: {
    type: 'boolean',
    default: true,
    description: 'Wake the monitor when DSH asks the operator a question.',
  },
  wakeOnLockedSession: {
    type: 'boolean',
    default: false,
    description:
      'Also run the wake when the session is locked. A locked session cannot be lit up, so this is off by default.',
  },
  minIntervalMs: {
    type: 'number',
    default: 15000,
    description: 'Minimum time between two wakes, so a burst of events triggers one wake.',
  },
  nudgeInput: {
    type: 'boolean',
    default: true,
    description:
      'Also emit a one-pixel mouse nudge (the cursor returns to its position), which dismisses a screen saver that already owns the screen.',
  },
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-screen-wake',
    validate(value) {
      const input = value ?? {}
      const issues = []
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'screen-wake: config must be an object' }] }
      }
      for (const key of Object.keys(input)) {
        if (!(key in CONFIG_FIELDS)) {
          issues.push({ message: `screen-wake: unknown config field "${key}"` })
        }
      }
      const out = {}
      for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
        const raw = input[key]
        if (raw === undefined) {
          out[key] = field.default
        } else if (typeof raw !== field.type) {
          issues.push({ message: `screen-wake: "${key}" must be a ${field.type}` })
        } else {
          out[key] = raw
        }
      }
      if (issues.length > 0) return { issues }
      return { value: out }
    },
  },
  // Documentation surface for the Plugin Manager card and cordis.patch.yml authors.
  type: 'object',
  additionalProperties: false,
  properties: CONFIG_FIELDS,
}

/**
 * Hard service dependency: declaring `webServer` here makes Cordis wait for the
 * web server before calling `apply`, so `ctx.webServer` is always present where
 * the routes are registered. (Reading it with `ctx.get()` during `apply` is not
 * equivalent: the service may not have activated yet, and the routes would then
 * silently never mount.)
 */
export const inject = ['webServer']

export function apply(ctx, config) {
  const resolved = {
    onTurnEnd: config?.onTurnEnd !== false,
    onAwaitingUser: config?.onAwaitingUser !== false,
    wakeOnLockedSession: config?.wakeOnLockedSession === true,
    minIntervalMs: Number.isFinite(config?.minIntervalMs) ? config.minIntervalMs : 15000,
    nudgeInput: config?.nudgeInput !== false,
  }

  if (process.platform !== 'win32') {
    ctx.logger?.info?.('[screen-wake] non-Windows platform; plugin inactive')
    return
  }

  let lastWakeAt = 0
  let inflight = false

  ctx.logger?.info?.(
    `[screen-wake] active (turnEnd=${resolved.onTurnEnd} awaitingUser=${resolved.onAwaitingUser} nudge=${resolved.nudgeInput} gen=${BUILD_TAG})`,
  )

  /** Run one PowerShell program through the subprocess service and parse its JSON last line. */
  async function runPowerShell(script) {
    const subprocess = ctx.get('subprocess')
    if (!subprocess) {
      throw new Error('subprocess service unavailable')
    }
    const handle = subprocess.spawn({
      argv: [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 5000,
      env: { ...process.env, DSH_WAKE_NUDGE: resolved.nudgeInput ? '1' : '0' },
    })

    await handle.done

    const text = String(handle.collected?.stdout?.readFrom(0)?.text ?? '').trim()
    const start = text.indexOf('{')
    return start >= 0 ? JSON.parse(text.slice(start)) : undefined
  }

  /** Run the wake script once. Failures are logged and never reach the session. */
  async function wake(reason) {
    if (inflight) return
    const now = Date.now()
    if (now - lastWakeAt < resolved.minIntervalMs) return
    lastWakeAt = now
    inflight = true

    try {
      const parsed = await runPowerShell(WAKE_SCRIPT)

      if (parsed?.locked && !resolved.wakeOnLockedSession) {
        ctx.logger?.info?.(`[screen-wake] ${reason}: session locked; skipped`)
        return
      }
      if (parsed && parsed.ok === false) {
        ctx.logger?.warn?.(`[screen-wake] ${reason}: SetThreadExecutionState failed`)
        return
      }
      ctx.logger?.info?.(`[screen-wake] ${reason}: monitor kept awake (locked=${parsed?.locked})`)
    } catch (error) {
      ctx.logger?.warn?.(`[screen-wake] ${reason}: ${error?.message ?? error}`)
    } finally {
      inflight = false
    }
  }

  /**
   * Switch the monitor off, for the sidebar button.
   *
   * The display-off timer is reset first so the operator's own mouse movement
   * (or a stray nudge) cannot immediately re-light the screen.
   */
  async function monitorOff() {
    const parsed = await runPowerShell(MONITOR_OFF_SCRIPT)
    const ok = parsed?.ok !== false
    ctx.logger?.info?.(`[screen-wake] monitor-off requested (ok=${ok})`)
    return ok
  }

  ctx.on('session/event', (session, event) => {
    if (isSubagentSession(session)) return

    if (resolved.onTurnEnd && event?.type === 'turn/end') {
      void wake('turn/end')
      return
    }

    if (
      resolved.onAwaitingUser &&
      event?.type === 'tool/call' &&
      AWAIT_TOOL_NAMES.has(event?.data?.name)
    ) {
      void wake('awaiting-user')
    }
  })

  // The sidebar button's endpoint. Loopback-only is the web server's own
  // posture; this handler answers JSON so the button can report a failure.
  // `webServer` is a declared dependency, so it is present here.
  const webServer = ctx.webServer
  ctx.logger?.info?.(
    `[screen-wake] webServer ${webServer ? 'present' : 'MISSING'} (register=${typeof webServer?.register})`,
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: MONITOR_OFF_PATH,
      handler: async (req, res) => {
        const headers = { 'content-type': 'application/json; charset=utf-8' }
        if (req.method !== 'POST') {
          res.writeHead(405, headers)
          res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
          return
        }
        try {
          const ok = await monitorOff()
          res.writeHead(ok ? 200 : 500, headers)
          res.end(JSON.stringify({ ok }))
        } catch (error) {
          ctx.logger?.warn?.(`[screen-wake] monitor-off failed: ${error?.message ?? error}`)
          res.writeHead(500, headers)
          res.end(JSON.stringify({ ok: false, error: 'monitor-off-failed' }))
        }
      },
    }),
  )

  // A read-only probe: it answers whenever THIS module generation is loaded, which
  // tells a stale Host (no route -> 401/404 from the shared /api channel) apart from
  // a mounted route whose action failed.
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: MONITOR_STATUS_PATH,
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            ok: true,
            plugin: '@local/dsh-plugin-screen-wake',
            generation: BUILD_TAG,
            platform: process.platform,
          }),
        )
      },
    }),
  )

  ctx.logger?.info?.(
    `[screen-wake] routes mounted: ${MONITOR_OFF_PATH}, ${MONITOR_STATUS_PATH}`,
  )
}
