/**
 * Point git at `.githooks/`, from pnpm's `prepare` lifecycle.
 *
 * Hooks that live in `.git/hooks/` are per-clone and untracked, which means the rules
 * they enforce are not really the repo's rules: they are whatever each machine
 * happened to have copied in. `core.hooksPath` moves them into the tree, where they
 * are versioned, reviewable, and arrive with the clone.
 *
 * Every failure mode here is a no-op rather than an error, and that is the whole
 * design. `prepare` runs inside `pnpm install`, `pnpm install` runs inside the web
 * image build, and the build context has no `.git` and no `scripts/` (both are in
 * .dockerignore). A hook installer that can fail is an installer that can stop a
 * deploy over something with no bearing on the running app.
 *
 * Run directly with `pnpm hooks:install`, which prints what it did either way.
 */

import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const HOOKS_DIR = '.githooks'
/** True when run as `pnpm hooks:install` rather than as a lifecycle script. */
const VERBOSE = process.argv.includes('--verbose') || process.env.npm_lifecycle_event === 'hooks:install'

function say(message) {
  if (VERBOSE) process.stdout.write(`${message}\n`)
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

try {
  // Not a checkout at all: a tarball, or a docker build context. Nothing to do, and
  // nothing worth saying about it.
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0)
} catch {
  process.exit(0)
}

if (!existsSync(join(HOOKS_DIR, 'pre-commit'))) {
  say(`${HOOKS_DIR}/pre-commit is not here. Nothing installed.`)
  process.exit(0)
}

let current = ''
try {
  current = git(['config', '--local', '--get', 'core.hooksPath'])
} catch {
  // Unset. git exits 1 for a missing key, which is not an error here.
}

if (current !== '' && current !== HOOKS_DIR) {
  // Somebody chose a different hooks directory on purpose. Overwriting that silently
  // from an install script is exactly the kind of thing that makes people distrust
  // install scripts.
  process.stdout.write(
    `core.hooksPath is set to "${current}", so ${HOOKS_DIR} was left alone.\n` +
      `Run: git config --local core.hooksPath ${HOOKS_DIR}\n`,
  )
  process.exit(0)
}

// The exec bit survives a clone for tracked files, but not a copy, an unzip, or a
// worktree created by some tools. Setting it costs nothing and a hook without it is
// silently never run, which is the worst possible failure for a check.
for (const entry of readdirSync(HOOKS_DIR)) {
  try {
    chmodSync(join(HOOKS_DIR, entry), 0o755)
  } catch {
    // A read-only checkout. The hook may still be executable already.
  }
}

if (current === HOOKS_DIR) {
  say(`Hooks already installed: core.hooksPath is ${HOOKS_DIR}.`)
  process.exit(0)
}

try {
  git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
  process.stdout.write(`Git hooks installed: core.hooksPath is now ${HOOKS_DIR}.\n`)
} catch {
  say('Could not set core.hooksPath. Hooks are not installed.')
}
