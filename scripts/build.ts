import { execSync } from 'child_process'
import { cpSync, existsSync, rmSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const BUN = process.execPath

console.log('Building Admiral...')

// 1. Build the React SPA with Vite
console.log('\n[1/4] Building frontend...')
execSync(`"${BUN}" x vite build`, { cwd: join(ROOT, 'src/frontend'), stdio: 'inherit' })

// 2. Copy dist to root so it's alongside the binary
const srcDist = join(ROOT, 'src/frontend/dist')
const outDist = join(ROOT, 'dist')
if (existsSync(outDist)) rmSync(outDist, { recursive: true, force: true })
cpSync(srcDist, outDist, { recursive: true })
console.log('[2/4] Frontend assets copied to ./dist/')

// 3. Compile the broker into a single binary
console.log('[3/4] Compiling broker binary...')
execSync(`"${BUN}" build src/broker/index.ts --compile --outfile admiral-broker`, { cwd: ROOT, stdio: 'inherit' })

// 4. Compile the Hono server into a single binary
console.log('[4/4] Compiling server binary...')
execSync(`"${BUN}" build src/server/index.ts --compile --outfile admiral`, { cwd: ROOT, stdio: 'inherit' })

console.log('\nBuild complete! Run: ./admiral-broker and ./admiral')
console.log('Note: the dist/ directory must be alongside the admiral binary.')
