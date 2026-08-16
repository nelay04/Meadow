---
agent: 'agent'
description: 'Add or update a CHANGELOG.md entry for Meadow from the real changes'
---

# Update the Changelog

## Purpose
Keep `CHANGELOG.md` an accurate record of what each milestone actually delivered,
written for somebody deciding whether to read the code, not for somebody who already
has.

## What this changelog is

Meadow ships in milestones, not on a version cadence, so the changelog is organised by
**phase** (M0 through M6) rather than by semver release. Each phase is a heading with
the date of the commit that completed it. That means the changelog and
`docs/core/ARCHITECTURE.md` section 9 describe the same thing from two angles: section
9 is the design record with the reasoning, and this is the delivery record. When they
disagree, one of them is wrong and it is worth finding out which before writing.

## Input to collect

Run these, and read the results before writing anything:

```@terminal
git log --pretty=format:"%h|%ad|%s" --date=format:'%d-%b-%Y' --reverse
```

```@terminal
git status --porcelain
```

For the phase being written, read the commit bodies rather than only the subjects. The
bodies in this repository carry the decisions:

```@terminal
git log --format="%B" <commit>
```

Then read the matching milestone section in `docs/core/ARCHITECTURE.md` section 9. It
records what a milestone delivered and which decisions were reversed, and it is the
better source for the "why" than a diff is.

## Rules

**Dates are `dd-mmm-yyyy`.** `06-Aug-2026`, not `2026-08-06` and not `Aug 6, 2026`.
Take the date from the commit that completed the phase, via `--date=format:'%d-%b-%Y'`.
Never invent one, and never use today's date for work that was committed earlier.

**Work that is not committed is `Unreleased`.** Give it the phase name and no date. It
gets its date when it is committed, not before.

**Group by what changed for a user, not by file.** Under each phase use only the
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

Edit `CHANGELOG.md` in place, newest phase first. Do not commit it.
