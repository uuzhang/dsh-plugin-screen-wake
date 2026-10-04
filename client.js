/**
 * Screen Wake — browser half.
 *
 * Registers one button in `sidebar.footer.action`, the sidebar-foot list that
 * renders beside Settings. Clicking it posts to the Host's
 * `/api/screen-wake/off` route, which powers the monitor down.
 *
 * Written as a plain-JavaScript module loader factory: React comes from the
 * browser module table, and no Harness Client package is imported. The icon is
 * an inline SVG so the entry has no styling dependency beyond the theme tokens.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-screen-wake',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace and the shared footer-action cell id. */
    const NS = 'screenWake'
    const ENTRY_ID = 'screen-wake-off'

    const zh = {
      'screenWake.off': '关闭显示器',
      'screenWake.offDetail': '让显示器立即息屏',
      'screenWake.sending': '正在关闭显示器…',
      'screenWake.ok': '显示器已关闭',
      'screenWake.failed': '关闭显示器失败',
      'screenWake.unauthorized': '未认证：请刷新页面后重试',
      'screenWake.notMounted': 'Host 未加载该功能，请重启 DSH 后重试',
    }
    const en = {
      'screenWake.off': 'Turn off display',
      'screenWake.offDetail': 'Switch the monitor off now',
      'screenWake.sending': 'Turning the display off…',
      'screenWake.ok': 'Display off',
      'screenWake.failed': 'Could not turn off the display',
      'screenWake.unauthorized': 'Not authenticated — reload the page and retry',
      'screenWake.notMounted': 'The Host has not loaded this feature; restart DSH',
    }

    /** Inject the stylesheet once, keyed by a data attribute so HMR does not stack copies. */
    const CSS_ID = '@local/dsh-plugin-screen-wake/sidebar-button'
    const CSS = [
      '.dshScreenWake_btn{width:36px;height:36px;flex:none;display:inline-flex;',
      'align-items:center;justify-content:center;gap:8px;padding:0;border:none;',
      'border-radius:50%;background:0 0;cursor:pointer;position:relative;',
      'color:var(--dsw-alias-label-secondary);',
      'transition:background-color .12s,color .12s,box-shadow .12s}',
      '.dshScreenWake_btn[data-wide="wide"]{width:auto;min-width:0;flex:auto;',
      'justify-content:flex-start;border-radius:999px;padding:0 10px}',
      '.dshScreenWake_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dshScreenWake_btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dshScreenWake_btn:focus-visible{outline:none;',
      'box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2),0 0 0 4px var(--dsw-alias-brand-primary)}',
      '.dshScreenWake_btn:disabled{opacity:.5;cursor:default}',
      '.dshScreenWake_btn[data-state="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.dshScreenWake_btn[data-state="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dshScreenWake_label{font-size:13px;font-weight:500;line-height:1;white-space:nowrap}',
      '@media (prefers-reduced-motion:reduce){.dshScreenWake_btn{transition:none}}',
    ].join('')

    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(
        'style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']',
      )
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-plugin-screen-wake'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /** A monitor glyph with a power slash, drawn inline. */
    function MonitorOffIcon({ size }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: 'none' },
        },
        h('rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2 }),
        h('path', { d: 'M9 20.5h6' }),
        h('path', { d: 'M12 17v3.5' }),
        h('path', { d: 'M12 6.2v8.6' }),
      )
    }

    /**
     * Render the sidebar-foot display-off button.
     * @param props - column state plus the locale seat injected by `locale: NS`.
     */
    function ScreenWakeEntry({ wide, t }) {
      const [state, setState] = React.useState('idle')
      const [detail, setDetail] = React.useState('')
      const timer = React.useRef(0)
      const mounted = React.useRef(false)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (timer.current !== 0) window.clearTimeout(timer.current)
        }
      }, [])

      const label = t('screenWake.off')

      const turnOff = React.useCallback(async () => {
        setState('sending')
        setDetail('')
        let next = 'error'
        let why = t('screenWake.failed')
        try {
          // Probe first: a mounted route answers 200 here, while a stale Host
          // falls through to the shared /api channel and refuses the caller.
          const probe = await fetch('api/screen-wake/status')
          if (!probe.ok) {
            const probeText = await probe.text()
            why = `${t('screenWake.notMounted')} (HTTP ${probe.status}: ${probeText.slice(0, 60) || 'empty'})`
          } else {
            const response = await fetch('api/screen-wake/off', { method: 'POST' })
            const text = await response.text()
            if (response.ok && !text.includes('"ok":false')) {
              next = 'ok'
              why = ''
            } else {
              why = `HTTP ${response.status}: ${text.slice(0, 80) || '(empty)'}`
            }
          }
        } catch (error) {
          why = `${t('screenWake.failed')} — ${error?.message ?? error}`
        }
        if (!mounted.current) return
        setState(next)
        setDetail(why)
        if (timer.current !== 0) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          if (mounted.current) setState('idle')
        }, 8000)
        // Keep the diagnostic in the console too, so it survives the button reset.
        if (why) console.warn('[screen-wake] display-off failed:', why)
      }, [t])

      const title =
        state === 'ok'
          ? t('screenWake.ok')
          : state === 'error'
            ? detail || t('screenWake.failed')
            : state === 'sending'
              ? t('screenWake.sending')
              : t('screenWake.offDetail')

      return h(
        'button',
        {
          type: 'button',
          className: 'dshScreenWake_btn',
          'data-dsh-plugin': 'screen-wake',
          'data-dsh-part': 'sidebar-button',
          'data-wide': wide ? 'wide' : 'rail',
          'data-state': state,
          'aria-label': label,
          title,
          disabled: state === 'sending',
          onClick: turnOff,
        },
        h(MonitorOffIcon, { size: wide ? 16 : 18 }),
        wide ? h('span', { className: 'dshScreenWake_label' }, state === 'error' && detail ? detail : label) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(ensureStyles, 'screen-wake: stylesheet')
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en })
          } catch {
            return () => {}
          }
        }, 'screen-wake: dictionaries')
        ctx.slots.inject('sidebar.footer.action', () => {
          try {
            return ctx.slots.register(
              { name: 'sidebar.footer.action', id: ENTRY_ID, locale: NS },
              ScreenWakeEntry,
            )
          } catch {
            return () => {}
          }
        })
      },
    }
  },
})
