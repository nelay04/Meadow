---
agent: 'agent'
description: 'Add or update a CHANGELOG.md entry for Meadow from the real changes'
model: 'sonnet'
---

# Update the Changelog

## Purpose
Keep `CHANGELOG.md` an accurate record of what each milestone actually delivered,
written for somebody deciding whether to read the code, not for somebody who already
has.

## What this changelog is

Meadow was developed in milestones, M0 through M6, and those sections stay as they
are. `1.0.0` (11-Sep-2026) is the deploy and ship of v1, and every release since is a
**semantic version** continuing from there:
MAJOR for a change that breaks existing boards, stored data, the API or the websocket
protocol; MINOR for a new feature that breaks nothing; PATCH for a bug fix. Each
version is a heading in this exact form:

```
## [1.10.4] - [06-Aug-2026]
```

The milestone sections and `docs/core/ARCHITECTURE.md` section 9 describe the same
thing from two angles: section 9 is the design record with the reasoning, and this is
the delivery record. When they
disagree, one of them is wrong and it is worth finding out which before writing.

## Input to collect

Run these, and read the results before writing anything:

```@terminal
TZ=Asia/Kolkata git log --pretty=format:"%h|%ad|%s" --date=format-local:'%d-%b-%Y' --reverse
```

```@terminal
git status --porcelain
```

For the version being written, read the commit bodies rather than only the subjects. The
bodies in this repository carry the decisions:

```@terminal
git log --format="%B" <commit>
```

Then read the matching milestone section in `docs/core/ARCHITECTURE.md` section 9. It
records what a milestone delivered and which decisions were reversed, and it is the
better source for the "why" than a diff is.

## Rules

**Dates are `dd-mmm-yyyy` in Indian Standard Time.** `06-Aug-2026`, not `2026-08-06`
and not `Aug 6, 2026`. Take the date from the release commit in IST (UTC+05:30), via
`TZ=Asia/Kolkata git log -1 --date=format-local:'%d-%b-%Y' --format=%ad <commit>`.
Never invent one, and never use today's date for work that was committed earlier.

**There is no `## [Unreleased]` section.** Every change is logged straight under its
own version heading with a date, bumping PATCH, MINOR or MAJOR by the rule above. If
the top entry is already this change's version (a follow-up fix in the same release),
add to it rather than opening a new one. The version bump is not only the heading: it
goes in the same change to `package.json`, `apps/web/package.json`,
`packages/schema/package.json`, `services/api/pyproject.toml`, and `services/api/uv.lock`
(run `uv lock`), plus the current-release line in `README.md`.

**Group by what changed for a user, not by file.** Under each version use only the
headings that apply, in this order: `Added`, `Changed`, `Fixed`, `Reversed`, `Known
limitations`. Skip the empty ones rather than writing "None".

**`Reversed` is not optional when it applies.** This project has thrown work away for
good reasons more than once, and a changelog that hides that is less useful than no
changelog. If a phase reverted an approach, say what was tried, what it cost, and what
replaced it. One or two lines.

**Numbers, only if measured.** Report a figure only where a benchmark or test produced
it, and say which one. If a target is unverified, say it is unverified rather than
omitting it, the same way section 11 does. A number without a source in this project is
a bug in the changelog.

**Vocabulary.** A board is a **glade**, remote cursors are **wanderers**. It was
**field** through M5, so phases before M6 keep that word where they used it. Keep
`board_id` when describing the database or the API.

**Style.** Plain ASCII. No emojis. Prefer plain punctuation over em dashes. Present the
change, not the process: "arrows stay attached through a resize" rather than "added a
call to reflowArrows".

**Do not pad.** A phase that delivered three things gets three bullets. Restating the
same change under two headings to make a section look fuller is worse than a short
section.

## Final output

Edit `CHANGELOG.md` in place, newest version first. Do not commit it.
