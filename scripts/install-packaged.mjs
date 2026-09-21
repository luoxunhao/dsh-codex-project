/**
 * Install the plugin into DSH profiles as a *packaged artifact* (pnpm pack →
 * `dsh plugin add <abs>.tgz`) instead of a dev `link:` into the working tree.
 *
 * The order below is not cosmetic — both failure modes were hit on 2026-09-21:
 *   1. `add <tgz>` over an existing link only rewrites package.json; the
 *      lockfile keeps `version: link:…` and node_modules keeps the symlink, so
 *      the install is a silent no-op. Detaching first is mandatory.
 *   2. `dsh plugin … remove` drops the dependency and the bundles entry but
 *      leaves the symlink on disk. The next `add` then walks it and tries to
 *      create a cross-drive symlink → ERR_PNPM_EPERM, half-installing the
 *      profile. The leftover link has to be unlinked by hand.
 *
 * A failed `add` is the dangerous one: pnpm can delete the copy that was
 * already installed while leaving the bundles entry behind, and dsh then
 * refuses to boot the profile at all. So the artifact is preflighted before any
 * profile is touched, and a failure restores the pre-run manifest + lockfile
 * before retrying — `dsh plugin install` on its own cannot recover, because the
 * poisoned lock re-triggers the very same failure.
 *
 * Afterwards every profile is verified with `dsh --profile <name> --dump-config`,
 * which composes the bundle stack (including the plugin's cordis patch layer)
 * without starting a server.
 *
 *   node scripts/install-packaged.mjs --profile web [--profile desktop]…
 *   --no-build   skip `pnpm build` (only safe when lib/ is already current)
 *   --dry-run    print what would happen, touch nothing
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const profileRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** dsh and pnpm are .cmd shims on Windows, which need cmd.exe (i.e. a shell). */
function run(cmd, args, cwd = repoRoot) {
  const win = process.platform === 'win32'
  const bin = win ? `${cmd}.cmd` : cmd
  // With shell:true Node only concatenates args, so quote (and vet) them here.
  const r = win
    ? spawnSync(`${bin} ${args.map(winArg).join(' ')}`, { cwd, stdio: 'pipe', encoding: 'utf8', shell: true })
    : spawnSync(bin, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
  if (r.error) fail(`${cmd} ${args.join(' ')}: ${r.error.message}`)
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function winArg(a) {
  const s = String(a)
  if (/["&|<>^%]/.test(s)) fail(`refusing to pass a shell metacharacter in: ${s}`)
  return `"${s}"`
}

const isLinkIntoRepo = (p) => {
  try {
    return realpathSync(p) === realpathSync(repoRoot)
  } catch {
    return false
  }
}
const hashOf = (p) => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex')
  } catch {
    return ''
  }
}
const existsIncludingBrokenLink = (p) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
const step = (label) => console.log(`\n— ${label}`)

const BOOT_BUNDLES = ['index.js', 'fs.js', 'runner.js', 'client.js']
/** Relative path + cwd: GNU tar reads "E:\…" as a remote host and fails. */
function tarOut(args) {
  const r = spawnSync('tar', args, { cwd: repoRoot, encoding: 'utf8' })
  if (r.status !== 0) fail(`tar ${args.join(' ')}: ${r.stderr?.trim() || 'failed'}`)
  return r.stdout
}

const argv = process.argv.slice(2)
const profiles = []
let build = true
let dryRun = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--profile' || a === '-p') {
    const name = argv[++i]
    // Names reach the shell on Windows, so keep them to plain path segments.
    if (!/^[A-Za-z0-9._-]+$/.test(name ?? '')) fail(`--profile needs a plain profile name, got: ${name}`)
    // dsh's own guard (bin.js rejectElectronProfile) rejects this name on both
    // the boot and the plugin path, so there is nothing to install into.
    if (name.toLowerCase() === 'desktop') fail('"desktop" is reserved for the Electron application — dsh refuses to boot or manage it')
    profiles.push(name)
  } else if (a === '--no-build') build = false
  else if (a === '--dry-run') dryRun = true
  else if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/install-packaged.mjs --profile <name> [--profile <name>…] [--no-build] [--dry-run]')
    process.exit(0)
  } else fail(`unknown argument: ${a}`)
}
if (!profiles.length) fail(`no --profile given (available: ${readdirSync(profileRoot).join(', ')})`)

if (build) {
  step('pnpm build')
  const r = run('pnpm', ['build'])
  if (r.status !== 0) fail(`pnpm build failed:\n${r.out.slice(-2000)}`)
  console.log('  ok')
}

step('pnpm pack')
const tarballName = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
const tarball = join(repoRoot, tarballName)
const packed = run('pnpm', ['pack'])
if (packed.status !== 0) fail(`pnpm pack failed:\n${packed.out.slice(-2000)}`)
if (!existsSync(tarball)) fail(`pnpm pack did not produce ${tarballName}`)
console.log(`  ${tarball} (${statSync(tarball).size} bytes)`)

// Pre-flight the artifact *before* any profile is touched: `add` deletes the
// previously installed copy when it fails, and a bundles entry that no longer
// resolves makes dsh refuse to start the whole profile (AGENTS §3.9).
step('preflight: tarball contents')
const listing = tarOut(['-tzf', tarballName]).trim().split('\n')
const required = ['package/package.json', 'package/cordis.patch.yml', ...BOOT_BUNDLES.map((f) => `package/lib/${f}`)]
const missing = required.filter((p) => !listing.includes(p))
if (missing.length) fail(`refusing to install: tarball is missing ${missing.join(', ')}`)
const packedManifest = JSON.parse(tarOut(['-xzOf', tarballName, 'package/package.json']))
if (packedManifest.name !== pkg.name || packedManifest.version !== pkg.version) {
  fail(`tarball carries ${packedManifest.name}@${packedManifest.version}, expected ${pkg.name}@${pkg.version}`)
}
if (!packedManifest.dsh?.bundle?.patch) fail('tarball package.json has no dsh.bundle.patch — its cordis layer would never be applied')
console.log(`  ok: ${listing.length} entries, manifest + patch + ${BOOT_BUNDLES.length} lib bundles present`)

for (const profile of profiles) {
  const dir = join(profileRoot, profile)
  const manifestPath = join(dir, 'package.json')
  console.log(`\n══ profile ${profile}`)
  if (!existsSync(manifestPath)) fail(`${dir} is not a profile (available: ${readdirSync(profileRoot).join(', ')})`)

  // Snapshot so a failed add rolls back to the *previous* state, not to "no plugin".
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const snapshot = { manifest: readFileSync(manifestPath, 'utf8'), lock: existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null }

  const entry = join(dir, 'node_modules', ...pkg.name.split('/'))
  const profileManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = profileManifest.dependencies?.[pkg.name]
  const bundled = (profileManifest.dsh?.profile?.bundles ?? []).includes(pkg.name)
  const detached = !declared && !existsIncludingBrokenLink(entry) && !bundled
  // dsh only appends the bundles entry when the dependency is new, so a profile
  // whose bundle list was rewritten elsewhere must be detached fully first.
  const why = declared?.startsWith('link:') ? declared
    : isLinkIntoRepo(entry) ? 'node_modules entry points at the working tree'
    : declared && !bundled ? 'declared but missing from dsh.profile.bundles'
    : ''

  if (detached) {
    console.log('  nothing installed yet — will just add')
  } else if (why) {
    step(`detach (${why})`)
    if (dryRun) {
      console.log('  would remove, then unlink a leftover symlink')
    } else {
      const rm = run('dsh', ['plugin', '--profile', profile, 'remove', pkg.name], dir)
      if (rm.status !== 0) fail(`remove failed:\n${rm.out.slice(-2000)}`)
      // pnpm leaves the symlink on disk; it is what poisons the next add.
      if (existsIncludingBrokenLink(entry)) {
        if (!isLinkIntoRepo(entry)) fail(`${entry} survived the remove but is not a link into this repo — refusing to delete it`)
        rmSync(entry)
        console.log('  removed leftover symlink (target untouched)')
      }
    }
  } else {
    console.log(`  already packaged: ${declared ?? '(not declared)'}`)
  }

  if (dryRun) {
    step(`dry-run: would add ${tarball} and verify`)
    continue
  }

  step('add')
  let add = run('dsh', ['plugin', '--profile', profile, 'add', tarball.replace(/\\/g, '/')], dir)
  if (add.status !== 0) {
    console.log('  add failed — retrying once (pnpm fetches the plugin dependencies too)')
    add = run('dsh', ['plugin', '--profile', profile, 'add', tarball.replace(/\\/g, '/')], dir)
  }
  if (add.status !== 0) {
    // A failed add can delete the previously installed copy while leaving the
    // bundles entry in place — then dsh refuses to boot the profile at all
    // ("cannot resolve profile bundle"). Recover in order of least loss.
    if (run('dsh', ['--profile', profile, '--dump-config'], dir).status === 0) {
      fail(`add failed, profile still boots:\n${add.out.slice(-2000)}`)
    }
    console.log('  profile no longer boots — restoring the pre-run manifest and lockfile')
    writeFileSync(manifestPath, snapshot.manifest)
    if (snapshot.lock !== null) writeFileSync(lockPath, snapshot.lock)
    run('dsh', ['plugin', '--profile', profile, 'install'], dir)
    if (run('dsh', ['--profile', profile, '--dump-config'], dir).status === 0) {
      fail(`add failed; profile rolled back to its previous state:\n${add.out.slice(-2000)}`)
    }
    run('dsh', ['plugin', '--profile', profile, 'remove', pkg.name], dir)
    fail(`add failed and the previous state could not be restored — dropped the bundles entry so dsh boots again, plugin uninstalled from "${profile}":\n${add.out.slice(-2000)}`)
  }
  console.log('  ok')

  step('verify')
  const lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').split('\n')
  const at = lock.findIndex((line) => line.trim() === `'${pkg.name}':`)
  const lockVersion = lock.slice(at, at + 4).find((line) => line.trim().startsWith('version:'))?.trim().slice('version:'.length).trim() ?? '(no importer entry)'
  const installed = JSON.parse(readFileSync(join(entry, 'package.json'), 'utf8'))
  const dump = run('dsh', ['--profile', profile, '--dump-config'], dir)
  // Version equality is not enough: `file:` tarballs carry no integrity in the
  // lockfile, so a re-pack of the same version can leave the old copy installed.
  const stale = ['client.js', 'index.js', 'fs.js', 'runner.js']
    .filter((f) => hashOf(join(repoRoot, 'lib', f)) !== hashOf(join(entry, 'lib', f)))
  const checks = [
    [`lockfile resolved the tarball, not a link (${lockVersion.split('(')[0]})`, !lockVersion.startsWith('link:') && lockVersion.includes(tarballName)],
    ['node_modules entry is not a link into the working tree', !isLinkIntoRepo(entry) && !lstatSync(entry).isSymbolicLink()],
    [`installed version is ${pkg.version}`, installed.version === pkg.version],
    [stale.length ? `installed lib/ is stale (${stale.join(', ')})` : 'installed lib/ matches the fresh build byte for byte', !stale.length],
    ['listed in dsh.profile.bundles', (JSON.parse(readFileSync(manifestPath, 'utf8')).dsh?.profile?.bundles ?? []).includes(pkg.name)],
    ['profile composes end to end (--dump-config exits 0)', dump.status === 0],
    ['bundle patch layer composed (core fs-sandbox swapped)', dump.out.includes(`patched by ${pkg.name}`)],
    ['plugin host + fs rows present in the tree', dump.out.includes(`name: '${pkg.name}'`) && dump.out.includes(`name: '${pkg.name}/fs'`)],
  ]
  const bad = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (bad.length) fail(`${bad.length} check(s) failed for profile ${profile} — inspect ${dir}`)
  console.log(`  pinned to file:${tarball.replace(/\\/g, '/')} — deleting that tarball breaks reinstall`)
}
