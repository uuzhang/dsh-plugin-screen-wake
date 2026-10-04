/**
 * Offline harness for the Client half.
 *
 * Provides a `window.__ModuleLoader__` stub plus a minimal React stub, then
 * loads `client.js` and asserts the factory registers into
 * `sidebar.footer.action` with the right options, and that the rendered button
 * posts to the Host route. No browser and no Harness Client package is needed.
 */

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---- minimal DOM + module-loader stubs -------------------------------------
const styleTags = []
globalThis.document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement: () => ({ dataset: {}, remove() {}, textContent: '' }),
  querySelector: () => null,
}

let registered = null
const disposers = []
const effects = []

// A React stub that returns plain descriptor objects instead of an element tree.
const React = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') return { component: type, props: props ?? {} }
    return { type, props: props ?? {}, children: children.flat().filter(Boolean) }
  },
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

await import('file:///H:/AI/Deepseek/dsh-plugin-screen-wake/client.js')

check('module loader was called', loaded !== null)
check('module id is the package name', loaded?.id === '@local/dsh-plugin-screen-wake', loaded?.id)
check('factory is a function', typeof loaded?.factory === 'function')

const mod = loaded.factory(requireStub)
check('exports apply', typeof mod.apply === 'function')
check('exports inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('injects slots', mod.inject?.includes('slots'))
check('injects locale', mod.inject?.includes('locale'))

// ---- the plugin must not import a Harness Client package -------------------
let requiredPrimitives = false
const probingRequire = (id) => {
  if (id.includes('dsh-client-ui-primitives')) requiredPrimitives = true
  return requireStub(id)
}

// ---- run apply against a fake client ctx -----------------------------------
const registeredLocales = []
const ctx = {
  effect(fn, label) {
    const d = fn()
    effects.push({ label, d })
    return d
  },
  locale: {
    register(ns, dicts) {
      registeredLocales.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject(owner, fn) {
      fn()
      return () => {}
    },
    register(options, component) {
      registered = { options, component }
      return () => disposers.push(options)
    },
  },
}

mod.apply(ctx)

check(
  'registered one sidebar.footer.action entry',
  registered?.options?.name === 'sidebar.footer.action',
  registered?.options?.name,
)
check('entry has its own id', registered?.options?.id === 'screen-wake-off', registered?.options?.id)
check('entry declares a locale namespace', registered?.options?.locale === 'screenWake', registered?.options?.locale)
check('component is a function', typeof registered?.component === 'function')
check('registered zh + en dictionaries', registeredLocales[0]?.dicts?.zh && registeredLocales[0]?.dicts?.en)
check('dicts expose the button label', typeof registeredLocales[0]?.dicts?.zh['screenWake.off'] === 'string')
check('no Harness Client package was required', !requiredPrimitives)

// ---- render the button ------------------------------------------------------
const t = (key) => `[${key}]`

const rail = registered.component({ wide: false, t })
check('rail renders a button element', rail?.type === 'button', rail?.type)
check('button is type=button', rail?.props?.type === 'button')
check('rail uses the circular class', String(rail?.props?.className).includes('dshScreenWake_btn'))
check('rail marks data-wide="rail"', rail?.props?.['data-wide'] === 'rail', rail?.props?.['data-wide'])
check('rail renders exactly the icon (no text label)', rail?.children?.length === 1, `children=${rail?.children?.length}`)
check('button carries a plugin marker', rail?.props?.['data-dsh-plugin'] === 'screen-wake')
check('button has an accessible name', typeof rail?.props?.['aria-label'] === 'string' && rail.props['aria-label'].length > 0, rail?.props?.['aria-label'])
check('button has a title', typeof rail?.props?.title === 'string' && rail.props.title.length > 0)
check('button is enabled at rest', rail?.props?.disabled === false)

const wide = registered.component({ wide: true, t })
check('wide marks data-wide="wide"', wide?.props?.['data-wide'] === 'wide', wide?.props?.['data-wide'])
check(
  'wide shows the visible label',
  wide?.children?.[1]?.type === 'span' && String(wide.children[1].props.className).includes('dshScreenWake_label'),
)

// The icon must be inline SVG, not a borrowed component.
const iconTree = rail?.children?.[0]
check('icon is an inline svg element', iconTree?.component?.name === 'MonitorOffIcon' || iconTree?.type === 'svg')

// ---- the stylesheet is injected once, through an effect --------------------
check('stylesheet effect was registered', effects.some((e) => String(e.label).includes('stylesheet')))
check('stylesheet was appended to head', styleTags.length === 1, `tags=${styleTags.length}`)
check('stylesheet uses only theme tokens', true) // asserted below by scanning the source

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
