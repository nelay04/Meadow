---
agent: 'agent'
description: 'Generate a conventional-commit title for the local diff in Meadow'
---

# Generate Commit Title

## Purpose
Provide a single-line, ready-to-paste git commit title (<= 72 characters) that reflects
the most important local changes since `HEAD`.

## Input to collect
- Run exactly one command to view the local diff:
  ```@terminal
  git diff HEAD
  ```

## Secondary input to collect
- Check for anything not yet staged that hints at the intent of the change:
  ```@terminal
  git status --porcelain
  ```
- If `CHANGELOG.md` is part of the diff, its newest entry already states the change in
  user-facing terms. Prefer that wording over paraphrasing the code.
- If `docs/core/ARCHITECTURE.md` is part of the diff, read what changed there. This
  project records decisions and reversals in the milestone sections, so a change that
  touches ARCHITECTURE is usually the headline rather than a footnote.

## How to decide the title

1. Find the dominant area and the change type. Areas in this repository, and the scope
   each one takes:

   | Path | Scope |
   |---|---|
   | `apps/web/src/canvas/` — camera, renderers, hit-testing, tools, overlay | `canvas` |
   | `apps/web/src/canvas/overlay/`, TipTap, text objects | `overlay` |
   | `apps/web/src/doc/` — CRDT schema and `mutations.ts` | `doc` |
   | `apps/web/src/sync/` — provider, reconnection, ws-tokens, awareness | `sync` |
   | `apps/web/src/features/` — auth screens, boards list, board page | `web` |
   | `packages/schema/` — `ObjectData`, arrow geometry, binding maths | `schema` |
   | `services/api/app/api/`, `app/auth/`, `app/services/permissions.py` | `auth` or `api` |
   | `services/api/app/realtime/` — ws endpoint, rooms, YStore | `sync` |
   | `services/api/app/workers/` — arq worker, compaction | `worker` |
   | `services/api/alembic/` | `db` |
   | `docker/`, `docker-compose*.yml`, `.env*.example` | `docker` |
   | `.github/workflows/` | `ci` |
   | `scripts/` — gate, smokes, e2e, benchmarks, stack check | `test` |
   | `README.md`, `docs/`, `CHANGELOG.md` | `docs` |

2. Describe what a user of the app gets, not the mechanics, when the two differ.
   "keep arrows attached when a shape is resized" beats "recompute anchors in
   reflowArrows". Reserve mechanism-first titles for changes with no user-visible face,
   such as build and CI work.

3. Use this project's vocabulary in the summary where it fits: a board is a **glade**,
   remote cursors are **wanderers**. Keep `board_id` in anything describing the DB or
   the API, which are deliberately not renamed.

## Final output
- Reply with only the commit title on a single line. No extra text, no backticks.

## Commit title convention

This repository uses Conventional Commits **with a scope**:

`<type>(<scope>): <summary>`

**Allowed types**
- feat, fix, docs, refactor, perf, test, build, ci, chore

**Scope rules**
- Include the scope, from the table above. Every commit in this repository's history
  after the first is written as `type(scope): summary`.
- One scope, not a list. If a change genuinely spans several, name the one that carries
  the intent and let the body cover the rest. A change touching `canvas` and `schema`
  because the arrow maths moved is still `feat(canvas)`.
- The bootstrap commit is the only scopeless one, and only because it created every
  area at once. Do not use that as a precedent.

**Summary rules**
- Imperative, present tense ("add", "update", "remove", "fix")
- <= 72 characters, no trailing punctuation, plain ASCII
- No emojis anywhere, in the title or the body. Prefer plain punctuation over em
  dashes, per `.claude/CLAUDE.md`.
- Be specific. "misc changes" and "various fixes" are never acceptable.
- Say which side is affected when a change exists on both. Viewer enforcement,
  permissions, and presence all have a client half and a server half, and "server-side"
  or "in the client" is what makes the title useful.

**Body rules**
- Wrap at 76 characters.
- Say what changed and why it was the right call, not a file list. `git show` prints
  the file list already.
- If the change reverses an earlier decision, say so and say what the earlier one cost.
  This project's history is meant to be readable as a record of decisions.
- If a test was written before the fix, which the working agreement requires for
  anything auth- or permission-related, say so.

**Examples** (real commits from this repository)
- `feat: M0 - yjs sync foundation on FastAPI + pycrdt`
- `feat(auth): user accounts, workspaces, and board access control`
- `feat(canvas): camera, viewport, and render loop`
- `feat(overlay): DOM text layer synced to canvas camera`
- `feat(canvas): arrows with shape binding`
- `feat(sync): awareness presence for live peers`
