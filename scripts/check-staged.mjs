/**
 * The repo's own rules, read off the lines that are actually being committed.
 *
 * `.claude/CLAUDE.md` lists non-negotiables that no tool in this stack enforces. tsc
 * will not tell you that `src/canvas/` imported from `src/features/`, and ruff has no
 * opinion about a second place computing a permission. Those rules are the ones worth
 * checking mechanically, because they are invisible until the thing they protect is
 * already broken: the canvas stops being extractable, or two functions disagree about
 * who may write to a glade.
 *
 * Added lines only, never whole files. A rule that fires on everything it can see
 * turns a one-line fix into a repo-wide cleanup, and the commit that trips it is
 * usually not the one that should pay for that. Touch a line, own that line.
 *
 * Two severities, and the difference is deliberate:
 *
 *   failures  block the commit. Each one is a stated non-negotiable, and each has a
 *             mechanical fix.
 *   notes     print and do nothing. These are judgement calls, and a hook that blocks
 *             on a judgement call teaches people to pass --no-verify, after which the
 *             real checks stop running too.
 *
 * Usage:
 *   node scripts/check-staged.mjs           failures, exit 1 if any
 *   node scripts/check-staged.mjs --notes   advisories only, always exit 0
 */

import { execFileSync } from 'node:child_process'

const NOTES_ONLY = process.argv.includes('--notes')

/** Five MiB. Above this, a file in git history is a file in everyone's clone forever. (Raised to accommodate splash videos) */
const MAX_BLOB_BYTES = 5 * 1024 * 1024

/** The one long-lived design doc. Its section 2 is the repository layout. */
const DOC = 'docs/core/ARCHITECTURE.md'

/** The workflow that runs the suites. Nothing else in this repo runs them. */
const CI = '.github/workflows/ci.yml'

function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/**
 * Paths staged for this commit, additions and modifications only.
 *
 * Deletions are excluded throughout: a rule firing on a line that is being removed is
 * the exact opposite of what anyone wants.
 */
function stagedPaths() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter((path) => path !== '')
}

/**
 * Every added line, as `{ file, line, text }`.
 *
 * Parsed from a zero-context diff rather than by reading the files, because the file
 * on disk is not necessarily what is staged. Someone who edits after `git add` would
 * otherwise be checked against work that is not in the commit.
 */
function addedLines() {
  const diff = git(['diff', '--cached', '--unified=0', '--diff-filter=ACMR'])
  const out = []

  let file = null
  let lineNumber = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // `+++ /dev/null` is a deletion; `+++ b/path` names the post-image.
      const path = raw.slice(4)
      file = path === '/dev/null' ? null : path.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('@@')) {
      // @@ -old,count +new,count @@
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
      lineNumber = match === null ? 0 : Number(match[1])
      continue
    }
    if (file !== null && raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: lineNumber, text: raw.slice(1) })
      lineNumber += 1
    }
  }

  return out
}

const ts = (file) => /\.tsx?$/.test(file)

/*
 * ---- Failures -------------------------------------------------------------------
 *
 * `where` narrows a rule to the files it is about, `test` runs against one added line.
 * Keeping the two separate is what stops "no explicit any" from firing inside a
 * Python docstring that happens to contain the words.
 */
const FAILURES = [
  {
    name: 'conflict marker',
    why: 'A merge was committed half-resolved.',
    where: () => true,
    test: (text) => /^(<{7}|>{7})\s/.test(text),
  },
  {
    name: 'emoji',
    why: 'CLAUDE.md: no emojis in the codebase.',
    // ARCHITECTURE.md predates the rule and uses a warning glyph as a structural
    // marker in its milestone list. Rewriting those is churn in the one document
    // nobody should be discouraged from editing.
    where: (file) => file !== 'docs/core/ARCHITECTURE.md',
    test: (text) => /\p{Extended_Pictographic}/u.test(text),
  },
  {
    name: 'canvas imports features',
    why: 'CLAUDE.md 6: the engine stays independent and extractable.',
    where: (file) => file.startsWith('apps/web/src/canvas/'),
    test: (text) => /^\s*(?:import|export)\b[^\n]*['"][^'"]*features\//.test(text),
  },
  {
    name: 'Y.Doc write outside document-core',
    why: 'CLAUDE.md 3: all Y.Doc writes go through @meadow/document-core.',
    // The write path moved out of `apps/web/src/doc` into its own package, so the MCP
    // server could stop reaching into the app for it. `apps/web/src/doc` is still
    // exempt: what stayed there (the React bindings, the canvas host, the clipboard)
    // wraps the same mutations and has the same licence to transact.
    where: (file) =>
      (file.startsWith('apps/web/src/') && !file.startsWith('apps/web/src/doc/')) ||
      (file.startsWith('packages/mcp/src/') && !file.startsWith('packages/mcp/test/')),
    test: (text) => /\btransact\s*\(/.test(text),
  },
  {
    name: 'explicit any',
    why: 'CLAUDE.md style: TypeScript is strict, no `any`.',
    where: ts,
    test: (text) => /(?::\s*any\b|\bas\s+any\b|<any>|\bany\[\])/.test(text),
  },
  {
    name: 'default export',
    why: 'CLAUDE.md style: no default exports except route components.',
    where: (file) =>
      ts(file) &&
      !/(?:^|\/)App\.tsx$/.test(file) &&
      !/Page\.tsx$/.test(file) &&
      !/\.config\.[cm]?tsx?$/.test(file),
    test: (text) => /^\s*export\s+default\b/.test(text),
  },
  {
    name: 'hardcoded site address',
    why:
      'CLAUDE.md 12: write https://meadow.invalid, which the web container fills in ' +
      'from MEADOW_WEB_BASE_URL.',
    where: (file) => file.startsWith('apps/web/') || file.startsWith('packages/'),
    test: (text) => /meadow\.creara\.in/.test(text),
  },
]

/*
 * ---- Notes ----------------------------------------------------------------------
 */
const NOTES = [
  {
    name: 'em dash',
    why: 'CLAUDE.md: use fewer em dashes. A comma or a full stop usually reads better.',
    where: () => true,
    // Written as an escape rather than as the character, so this rule does not report
    // its own definition on every commit that touches this file.
    test: (text) => /\u2014/.test(text),
  },
  {
    name: 'interface',
    why: 'CLAUDE.md style prefers `type`. Fine for `declare global` and for a real contract.',
    where: ts,
    test: (text) => /^\s*(?:export\s+)?interface\s+(?!Window\b)/.test(text),
  },
  {
    name: 'console',
    why: 'Shipped code should not log to the console. The bench and dev harnesses may.',
    where: (file) =>
      file.startsWith('apps/web/src/') &&
      !file.startsWith('apps/web/src/bench/') &&
      !file.startsWith('apps/web/src/dev/'),
    test: (text) => /\bconsole\.\w+\(/.test(text),
  },
]

/** `{ rule, findings: [{ file, line, text }] }` for whichever set was asked for. */
function scan(rules, lines) {
  return rules
    .map((rule) => ({
      rule,
      findings: lines.filter((entry) => rule.where(entry.file) && rule.test(entry.text)),
    }))
    .filter((group) => group.findings.length > 0)
}

/*
 * Rules that are about the repository rather than about a line.
 *
 * These read the tree, not the diff, so they only run when the commit touches the area
 * they are about. Otherwise a frontend commit would fail on a Python file it never
 * looked at, which is both confusing and someone else's problem.
 */
function repoWideFailures(paths) {
  const out = []

  const touchesApi = paths.some((path) => path.startsWith('services/api/'))
  if (touchesApi) {
    // CLAUDE.md: permission resolution lives in exactly one function. A second one is
    // not a style problem. It is two answers to "may this person write here", and the
    // websocket handshake is the security boundary that depends on there being one.
    const definitions = git(['grep', '-n', '-e', 'def resolve_role', '--', 'services/api/app'])
      .split('\n')
      .filter((line) => line !== '')

    if (definitions.length > 1) {
      out.push({
        rule: {
          name: 'second resolve_role',
          why: 'CLAUDE.md: permission resolution lives in exactly one function.',
        },
        findings: definitions.map((entry) => {
          const [file, line] = entry.split(':')
          return { file, line: Number(line), text: 'def resolve_role' }
        }),
      })
    }
  }

  // The repository layout in ARCHITECTURE 2 against the workspace that exists.
  //
  // This is the one check that stops documentation drift recurring rather than being
  // cleaned up again. `06833ec` was a one-time correction of four frontend picks that
  // had never been installed, and 1.26.0 added a fourth package while the doc still
  // said three. Both were found by a reader noticing, which is not a mechanism.
  //
  // Only the package list, and deliberately. ARCHITECTURE 1 is the richer table, but
  // its Choice column is prose - "PixiJS 8", "TipTap 3 (ProseMirror)", "PostgreSQL 16" -
  // so matching it to manifest keys needs an alias map that goes stale exactly as fast
  // as the document. Worse, the paragraphs around those tables name Zustand, Tailwind
  // and Sentry in sentences explaining they were dropped, so a prose scan would fail on
  // the text that records the reversal. A workspace directory is an exact string and
  // needs no map, which is why this rule is about those and nothing else.
  //
  // Read from the index, not from disk, for the same reason every other rule here is:
  // a package staged for this commit counts, and one deleted in it does not.
  const manifestPaths = paths.filter((path) =>
    /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path),
  )
  if (manifestPaths.length > 0 || paths.includes('pnpm-workspace.yaml') || paths.includes(DOC)) {
    const present = new Set(
      git(['ls-files', '--cached', '-z', '--', 'apps', 'packages'])
        .split('\0')
        .filter((path) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path))
        .map((path) => path.replace(/\/package\.json$/, '')),
    )

    let doc = ''
    try {
      doc = git(['show', `:${DOC}`])
    } catch {
      // The doc is not in the index at all, which is not this rule's problem to report.
      doc = ''
    }

    // Section 2 alone, not the whole document. Scoping matters more than it looks:
    // `packages/document-core` is named nine times in section 4, so a document-wide
    // scan would have called the 1.26.0 layout current while section 2 still said
    // three packages. Section 2 is the layout, so section 2 is what must match, and a
    // package named only in a milestone section is history rather than a claim.
    const layout = /\n## 2\.[^\n]*\n([\s\S]*?)(?=\n## )/.exec(doc)

    if (layout !== null) {
      // Two segments only. A mention of `packages/schema/src/text.ts` is a mention of
      // `packages/schema`, which is what this compares.
      const named = new Set(
        [...layout[1].matchAll(/`((?:apps|packages)\/[a-z0-9][a-z0-9-]*)[`/]/g)].map(
          (match) => match[1],
        ),
      )

      const undocumented = [...present].filter((path) => !named.has(path)).sort()
      const vanished = [...named].filter((path) => !present.has(path)).sort()

      if (undocumented.length > 0) {
        out.push({
          rule: {
            name: 'package missing from ARCHITECTURE',
            why: `${DOC} 2 is the repository layout. A package it does not name is a package nobody reading the design knows exists.`,
          },
          findings: undocumented.map((path) => ({
            file: `${path}/package.json`,
            line: 1,
            text: 'on disk, absent from the doc',
          })),
        })
      }

      if (vanished.length > 0) {
        out.push({
          rule: {
            name: 'ARCHITECTURE names a package that is gone',
            why: `Remove it from ${DOC} 2, or say in the milestone section that it was reversed and when.`,
          },
          findings: vanished.map((path) => ({
            file: DOC,
            line: 1,
            text: `names ${path}, which is not in the workspace`,
          })),
        })
      }

      // The sentence counts them in words, so the count goes stale on its own.
      const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
      const counted = /\b([A-Z][a-z]+) JS packages\b/.exec(layout[1])
      if (counted !== null) {
        const claimed = WORDS.indexOf(counted[1].toLowerCase())
        if (claimed >= 0 && claimed !== present.size) {
          out.push({
            rule: {
              name: 'ARCHITECTURE package count is wrong',
              why: `${DOC} 2 says "${counted[1]} JS packages"; the workspace has ${present.size}.`,
            },
            findings: [{ file: DOC, line: 1, text: `${counted[1]} claimed, ${present.size} present` }],
          })
        }
      }
    }
  }

  // Every browser-driven suite against the workflow that is supposed to run it.
  //
  // Four suites sat broken for about three weeks and nobody noticed, and the reason was
  // not that CI is manual. Two of them, `e2e:sessions` and `e2e:connect`, were in no
  // workflow at all, so no trigger would have reached them however often it fired. A
  // suite nobody runs is a suite that rots, and the only way it stays wired in is if
  // adding one without wiring it in fails.
  //
  // Scoped to `e2e:` and `smoke:`, the two that pass or fail. Benchmarks report numbers
  // rather than a verdict, and the runner's hardware is not the hardware the targets are
  // about. `check:staged` runs in the hook rather than CI. `readme:shots` is a
  // screenshot generator, not a suite, and is the one thing here still broken as of
  // 1.27.5, so requiring it in a workflow would require a red step.
  if (paths.includes('package.json') || paths.includes(CI)) {
    let manifest = ''
    let workflow = ''
    try {
      manifest = git(['show', ':package.json'])
      workflow = git(['show', `:${CI}`])
    } catch {
      manifest = ''
    }

    // Comment lines stripped first. Without this a suite is "covered" by being named
    // in a comment, including a comment explaining why one of them is absent, which
    // would make this rule agree with itself and check nothing.
    const runnable = workflow
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')

    if (manifest !== '' && workflow !== '') {
      const scripts = JSON.parse(manifest).scripts ?? {}
      const gated = Object.entries(scripts).filter(([name]) => /^(?:e2e|smoke|readme):/.test(name))
      // Named either as the pnpm script or as the file it runs, because the workflow
      // legitimately does both: `pnpm e2e:board` in one job, `node scripts/...` in
      // another.
      const missing = gated
        .filter(([name, command]) => {
          if (runnable.includes(name)) return false
          const file = /(scripts\/[\w.-]+)/.exec(command)
          return file === null || !runnable.includes(file[1])
        })
        .map(([name]) => name)

      if (missing.length > 0) {
        out.push({
          rule: {
            name: 'suite in no workflow',
            why: `${CI} is where a suite gets run. One that is in neither this file nor any job will rot unnoticed, which is exactly what happened to five of them.`,
          },
          findings: missing.sort().map((name) => ({
            file: 'package.json',
            line: 1,
            text: `${name} is not named in ${CI}`,
          })),
        })
      }
    }
  }

  for (const path of paths) {
    if (/(^|\/)\.env(\.|$)/.test(path) && !/\.example$/.test(path)) {
      out.push({
        rule: { name: 'secret file', why: 'A real .env is gitignored for a reason.' },
        findings: [{ file: path, line: 1, text: 'staged' }],
      })
    }
    if (/\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519)$/.test(path)) {
      out.push({
        rule: { name: 'private key', why: 'Keys do not belong in git history.' },
        findings: [{ file: path, line: 1, text: 'staged' }],
      })
    }
  }

  // Size is read from the staged blob, not from disk, for the same reason the lines
  // are: what is being committed is the only thing that matters here.
  const sizes = git(['ls-files', '--stage', '-z', '--', ...(paths.length > 0 ? paths : ['.'])])
  const big = []
  for (const entry of sizes.split('\0')) {
    if (entry === '') continue
    const match = /^\d+ ([0-9a-f]+) \d+\t(.*)$/s.exec(entry)
    if (match === null) continue
    const [, sha, file] = match
    if (!paths.includes(file)) continue
    const bytes = Number(git(['cat-file', '-s', sha]).trim())
    if (bytes > MAX_BLOB_BYTES) big.push({ file, line: 1, text: `${Math.round(bytes / 1024)} KiB` })
  }
  if (big.length > 0) {
    out.push({
      rule: {
        name: 'large file',
        why: `Over ${MAX_BLOB_BYTES / 1024} KiB. Git keeps it in every clone forever.`,
      },
      findings: big,
    })
  }

  return out
}

function report(groups, heading) {
  const total = groups.reduce((sum, group) => sum + group.findings.length, 0)
  if (total === 0) return 0

  process.stdout.write(`${heading}\n\n`)
  for (const { rule, findings } of groups) {
    process.stdout.write(`  ${rule.name}: ${rule.why}\n`)
    for (const finding of findings.slice(0, 10)) {
      const text = finding.text.trim()
      process.stdout.write(
        `    ${finding.file}:${finding.line}` + (text === '' ? '\n' : `  ${text.slice(0, 90)}\n`),
      )
    }
    if (findings.length > 10) {
      process.stdout.write(`    ... and ${findings.length - 10} more\n`)
    }
    process.stdout.write('\n')
  }
  return total
}

const paths = stagedPaths()
if (paths.length === 0) process.exit(0)

const lines = addedLines()

if (NOTES_ONLY) {
  // Advisory output is deliberately terse and flat: it is printed inside the hook's
  // tree, one line per finding, next to checks that actually passed.
  for (const { rule, findings } of scan(NOTES, lines)) {
    const first = findings[0]
    const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : ''
    process.stdout.write(`${rule.name}: ${first.file}:${first.line}${more}\n`)
  }
  process.exit(0)
}

const violations = [...scan(FAILURES, lines), ...repoWideFailures(paths)]
const count = report(violations, 'Repo rules, on the lines being committed:')

if (count > 0) {
  process.stdout.write(
    'These are the non-negotiables in .claude/CLAUDE.md. If one of them is wrong,\n' +
      'change the rule in that file and say why, rather than working around it here.\n',
  )
  process.exit(1)
}

process.exit(0)
