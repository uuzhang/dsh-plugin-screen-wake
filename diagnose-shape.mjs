/**
 * Reproduce Cordis' own plugin-shape resolution against the real module, to find
 * why the loader reports this row as `unsupported`.
 *
 * Cordis does: `resolveConfig(runtime, config)` reading `runtime.Config['~standard'].validate`.
 * The loader builds that `runtime` from the imported module's exports.
 */

const mod = await import('file:///H:/AI/Deepseek/dsh-plugin-screen-wake/index.js')

console.log('--- module exports ---')
for (const key of Object.keys(mod).sort()) {
  const v = mod[key]
  console.log(`  ${key}: ${typeof v}${Array.isArray(v) ? ` [${v.join(',')}]` : ''}`)
}

console.log('')
console.log('--- Cordis resolveConfig simulation ---')
const runtime = mod
if (!runtime.Config) {
  console.log('  runtime.Config is FALSY -> config passes through unvalidated')
} else {
  const std = runtime.Config['~standard']
  console.log(`  Config is truthy: yes`)
  console.log(`  Config['~standard'] present: ${std ? 'yes' : 'NO  <-- this throws "Cannot read properties of undefined (reading \'validate\')"'}`)
  if (std) {
    console.log(`  standard.version: ${std.version}`)
    console.log(`  typeof std.validate: ${typeof std.validate}`)
    const result = std.validate({})
    console.log(`  validate({}) -> ${JSON.stringify(result)}`)
  }
}

console.log('')
console.log('--- does the module have a callable apply? ---')
console.log(`  typeof apply: ${typeof mod.apply}`)
console.log(`  apply.length (declared args): ${mod.apply?.length}`)

console.log('')
console.log('--- inject shape Cordis expects (array or object map) ---')
console.log(`  inject: ${JSON.stringify(mod.inject)}`)

console.log('')
console.log('--- module namespace keys that could shadow Cordis internals ---')
for (const key of Object.keys(mod)) {
  if (['name', 'default', 'Config', 'inject', 'apply'].includes(key)) {
    console.log(`  ${key} = ${JSON.stringify(mod[key])?.slice(0, 80)}  [expected export]`)
  } else {
    console.log(`  ${key}  [UNEXPECTED extra export]`)
  }
}
