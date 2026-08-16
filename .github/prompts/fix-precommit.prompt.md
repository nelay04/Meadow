# Fix a Blocked Commit

## Purpose
The pre-commit hook (`.githooks/pre-commit`) has refused a commit, or is about to.
Find out why, fix the cause, and leave the tree in a state where the hook passes on its
own merits. Never by bypassing it.

## Input to collect
Run the hook against exactly what is staged. It reports the same way it does during a
commit, and it changes nothing:

```@terminal
pnpm hooks:run
```

If nothing is staged, the hook exits immediately and there is nothing to diagnose. Ask
what should be staged rather than guessing, or run the checks whole:

```@terminal
pnpm -r lint && pnpm --filter web test
```

For the Python half, from `services/api`:

```@terminal
.venv/bin/ruff check . && .venv/bin/mypy app/
```

## How to fix, by which check failed

**`repo rules`** - `scripts/check-staged.mjs` found a line that breaks a stated
non-negotiable from `.claude/CLAUDE.md`. Every one of these has a real fix and none of
them has a workaround:

| Finding | The fix |
|---|---|
| `canvas imports features` | Move what the engine needs into `src/canvas/` or pass it in through `ToolContext`. The engine has to stay extractable. |
| `Y.Doc write outside doc/` | Add the mutation to `src/doc/mutations.ts` and call it. A component must never open its own transaction. |
| `explicit any` | Type it. If the shape is genuinely unknown, `unknown` plus a narrowing check is the honest version. |
| `default export` | Named export. Route components are the only exception, and the rule already allows them. |
| `emoji` | Remove it. Words, or one of the icons in `src/ui/icons.tsx`. |
| `second resolve_role` | Delete the second one and call `app/services/permissions.py::resolve_role`. Two answers to "may this person write here" is a security bug, not a duplication. |
| `secret file` / `private key` | `git restore --staged` it, and check whether the value needs rotating. |
| `conflict marker` | Finish the merge. |

**`types (web)`** - `tsc --noEmit` over both packages. Read the first error rather than
the last: in this codebase a `packages/schema` change usually reports at every call
site in `apps/web`, and fixing the schema clears all of them.

**`tests (web)`** - `vitest run`. Fix the code, not the assertion, unless the test
encodes behaviour that genuinely changed. If it does, say so in the commit body.

**`lint (api)`** / **`types (api)`** - ruff at line length 100, mypy strict on `app/`.
`.venv/bin/ruff check . --fix` settles the mechanical half. mypy strict means no
implicit `Any` and no untyped defs, so the fix is nearly always a missing annotation.

## Notes the hook prints but does not block on
These are judgement calls. Act on them when they are right, say why when they are not,
and never treat one as a reason to bypass the hook:

- `em dash`, `interface`, `console` - style preferences from CLAUDE.md.
- source changed without `CHANGELOG.md` - if the change is user-visible, add it under
  `## [Unreleased]` per `.github/prompts/update-changelog.prompt.md`.
- `models.py` changed without a migration - run
  `.venv/bin/alembic revision --autogenerate`, then `.venv/bin/alembic check`.

## Rules
- Fix the cause. Do not weaken a rule in `scripts/check-staged.mjs` to make a finding
  go away, and do not add an exemption for the file you are working on.
- If a rule is genuinely wrong, say so plainly and propose the change to
  `.claude/CLAUDE.md` first. The checker follows that file, not the other way round.
- Never suggest `git commit --no-verify` as the answer. The one case where it is
  legitimate is a hook that is broken rather than a commit that is, and that is a bug
  report about the hook.
- Do not commit anything. The commit is the user's to make.

## Final output
- What failed, in one line per check.
- What you changed, and why that was the cause rather than a symptom.
- The output of a second `pnpm hooks:run`, proving it now passes.
