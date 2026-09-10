"""Load and performance harness.

The correctness suites in `tests/` answer "does it do the right thing". This answers
"how much of it, how fast, and where does it stop" - the three rows DECISIONS.md lists
as **not measured**: concurrent editors per board, cursor propagation latency, and
compaction throughput.

Kept apart from `tests/` on purpose. A load run takes minutes, needs a server of its
own on a real socket, and reports numbers rather than passing or failing, so putting
it under pytest would make `pytest` mean two different things depending on the day.
"""
