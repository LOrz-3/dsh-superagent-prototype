import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const fixture = dirname(fileURLToPath(import.meta.url)), repository = resolve(fixture, '../../..')
const installed = process.env.DSH_INSTALL_DIR
const temp = process.argv[2]
if (!installed || !temp || !isAbsoluteD(temp)) throw new Error('Supply the installed DSH runtime and a D-drive test directory')
function isAbsoluteD(path) { return /^D:[\\/]/i.test(resolve(path)) }
const run = await mkdtemp(join(resolve(temp), 'sa-guard-owner-'))
const requireOwn = createRequire(join(repository, 'package.json'))
const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
if (installedPackage.version !== '0.2.2-rc.3') throw new Error('The ownership probe requires the installed rc.3 runtime')
await mkdir(join(run, 'artifact'), { recursive: true })
await writeFile(join(run, 'artifact/package.json'), JSON.stringify({ name: 'dsh-superagent', private: true, type: 'module' }))
await writeFile(join(run, 'package.json'), JSON.stringify({ name: '@local/guard-owner', private: true, type: 'module', exports: { '.': './driver.mjs' } }))
for (const part of ['prompts', 'skills']) await cp(join(repository, part), join(run, 'artifact', part), { recursive: true })
for (const path of [join(run, 'node_modules'), join(run, 'artifact/node_modules')]) await symlink(join(installed, 'node_modules'), path, 'junction')
await cp(join(fixture, 'driver.mjs'), join(run, 'driver.mjs'))
const config = join(run, 'build.mjs')
await writeFile(config, `export default { entry: { adapter: ${JSON.stringify(join(fixture, 'entry.ts'))} }, outDir: ${JSON.stringify(join(run, 'artifact/lib'))}, format: 'esm', platform: 'node', target: 'es2024', fixedExtension: true, dts: false, clean: false, deps: { neverBundle: [/^@deepseek-ai\\//], alwaysBundle: ['zod'] } }\n`)
const manifestPath = requireOwn.resolve('tsdown/package.json'), bundler = JSON.parse(await readFile(manifestPath, 'utf8'))
const cli = join(dirname(manifestPath), typeof bundler.bin === 'string' ? bundler.bin : bundler.bin.tsdown)
const building = spawn(process.execPath, [cli, '--config', config], { cwd: repository, stdio: 'inherit', windowsHide: true })
const [built] = await once(building, 'exit')
if (built !== 0) throw new Error('Ownership probe artifact build failed')
const home = join(run, 'home'), profile = join(home, 'profiles/guard-owner-headless')
await mkdir(join(profile, 'node_modules/@local'), { recursive: true })
await symlink(run, join(profile, 'node_modules/@local/guard-owner'), 'junction')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'guard-owner-profile', private: true,
  dependencies: { '@local/guard-owner': `file:${run}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }))
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
const evidence = join(run, 'evidence.json'), overlay = join(run, 'overlay.yml')
await writeFile(overlay, JSON.stringify([
  ...['headless-runner', 'headless-startup', 'plugin-manager', 'settings', 'config-editor', 'session-title-llm', 'agent-instructions', 'goal-round-driver']
    .map(id => ({ id, disabled: true })),
  { id: 'sandbox-policy', inject: [], config: { mode: 'danger-full-access', workspaceRoot: run } },
  { id: 'approval', config: { policy: 'never' } },
  { insert: [{ id: 'guard-owner-proof', name: '@local/guard-owner', config: { directory: run, evidence } }] },
]))
const output = await open(join(run, 'stdout.log'), 'wx'), error = await open(join(run, 'stderr.log'), 'wx')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))
Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', TEMP: run, TMP: run })
const child = spawn(process.execPath, [join(installed, 'lib/bin.js'), '--profile', 'guard-owner-headless', '--patch', overlay],
  { cwd: run, env, stdio: ['ignore', output.fd, error.fd], windowsHide: true })
let exitCode
try { [exitCode] = await once(child, 'exit') }
finally { await output.close(); await error.close() }
let report
try { report = JSON.parse(await readFile(evidence, 'utf8')) }
catch { report = { assertionsStatus: 'failed-before-evidence', code: 'PROFILE_FAILED' } }
console.log(JSON.stringify({ ...report, cliExitCode: exitCode, evidence }))
if (exitCode !== 0 || report.assertionsStatus !== 'passed') process.exitCode = 1
