## Purpose

Reports what a task costs and how much conversation it takes, as distributions over the job threads
in the selected range: tokens per task, job turns (runs) per task, and agent turns per task — the
two turn kinds counted from different sources and never conflated.

## ADDED Requirements

### Requirement: Job turns and agent turns are reported as distinct figures

The payload and the dashboard SHALL report job turns and agent turns as separate figures with
separate labels, and no figure, label, or API field SHALL name a bare "turns" without saying which
kind it means. A job turn is one job row in a task thread — the first run or a follow-up, the
member delivering one prompt. An agent turn is one assistant response cycle in a run's root
conversation — one model response, whatever tool calls it contains; subagent conversations do not
count.

#### Scenario: Both figures present and separately labeled
- **WHEN** the per-task panel renders for a range with measured tasks
- **THEN** job turns (runs) per task and agent turns per task appear as distinct figures, each
  labeled with its kind

### Requirement: Tokens per task are reported as a distribution

For the tasks in scope for the selected range, the stats payload SHALL report the average, median
(p50) and p95 of per-task token totals. A task's token total SHALL be the sum of input and output
tokens over the sessions attributed to that task in the range; the four token types SHALL NOT be
summed into one figure, and cache reads SHALL NOT count toward a task's token total. Percentiles
SHALL use nearest-rank over tasks sorted ascending, so the figures are reproducible from the
underlying totals.

#### Scenario: Distribution over three tasks
- **WHEN** the range holds tasks with per-task totals of 1k, 2k and 3k tokens
- **THEN** the payload reports average 2k, p50 2k, and p95 3k tokens per task

#### Scenario: Sessions with no token data are excluded, not zeroed
- **WHEN** a task's attributed sessions carry null token totals (an unmapped agent, a session with
  no token rows)
- **THEN** that task is excluded from the token distribution rather than counted as a zero-total
  task, and the reported task count reflects the exclusion

#### Scenario: No tasks in range
- **WHEN** the selected range holds no tasks with attributed sessions
- **THEN** the token distribution figures are reported as unavailable (null), not zero, and the
  panel renders an explicit empty state

### Requirement: Agent turns are counted at run close from the session's own records

Each executor run SHALL report the count of assistant response cycles in its root conversation,
counted from the session's own records at run close — the session database for opencode, the
session transcript for claude-code — and the board SHALL store it on the run's job row. A count
that could not be taken (the record was unreadable, the run was killed before a read, the mode
keeps no record) SHALL be stored as unmeasured (null), never as zero. Both executor platforms
(docker and kubernetes) SHALL produce the count through their own close-time read.

#### Scenario: Headless run reports its turns
- **WHEN** a headless run's root conversation holds eleven assistant response cycles
- **THEN** the run's job row stores eleven agent turns

#### Scenario: Unreadable record is unmeasured, not zero
- **WHEN** the close-time read fails or the run was killed before it
- **THEN** the run's job row stores no agent-turn count, and no figure renders zero turns for it

#### Scenario: Subagent conversations do not count
- **WHEN** a run spawned subagent conversations beside its root conversation
- **THEN** only the root conversation's assistant response cycles are counted

### Requirement: Agent turns per task are reported as a distribution

For the tasks in scope, the payload SHALL report the average, p50 and p95 of agent turns per
task, where a task's total is the sum of its runs' stored agent-turn counts over the selected
range. A task with any in-range run whose agent turns are unmeasured SHALL be excluded from the
distribution rather than summed partially — a partial sum presented as a total is a quiet
undercount. The excluded-task rule is per-figure: a task missing turn data still participates in
the token and job-turn distributions.

#### Scenario: Follow-up adds its turns
- **WHEN** a task's first run took 9 agent turns and its follow-up took 4, both measured and both
  in range
- **THEN** the task's agent-turn total is 13 and enters the distribution as 13

#### Scenario: Unmeasured run excludes the task from the turn distribution only
- **WHEN** a task holds two in-range runs, one with 7 agent turns stored and one unmeasured
- **THEN** the task is excluded from the agent-turn distribution, and its tokens and job turns
  still count in theirs

### Requirement: Job turns (runs) per task are reported

For the tasks in scope, the payload SHALL report the average, p50 and p95 of job turns per task,
where a task's job-turn count is the number of its job rows queued within the selected range —
every run and follow-up counts once. The count SHALL come from the board's own rows, not inferred
from sessions.

#### Scenario: Follow-ups raise the job-turn count
- **WHEN** a task was run once and followed up twice in the range
- **THEN** its job-turn count is three, and the job-turn distribution counts it as three

#### Scenario: Runs counted per range
- **WHEN** a thread's first run fell outside the selected range and its follow-up fell inside
- **THEN** the task's job-turn count for that range is one

### Requirement: The measured task count is surfaced with every distribution

The payload SHALL report, per figure, how many tasks each distribution was computed over. A
distribution over very few tasks SHALL render beside its count, so a p95 over a handful of tasks
is never mistaken for a settled statistic.

#### Scenario: Small sample is visible
- **WHEN** a week holds four tasks
- **THEN** the per-task panel shows each distribution and its count, and the payload carries the
  same counts

### Requirement: Task statistics respect scope and attribution

Under caller scope, the per-task distributions SHALL cover only tasks authored by the caller.
Sessions without attribution contribute to no task's totals in any scope, and unattributed usage
remains visible only through the unattributed figure of the attribution capability.

#### Scenario: Caller scope narrows the task set
- **WHEN** a member requests caller-scoped figures and the range holds tasks by two members
- **THEN** the per-task distributions cover only the caller's tasks

### Requirement: A task enters the range on session or run overlap

A task SHALL be included in a range's statistics when any of its attributed sessions overlaps the
range or any of its runs was queued within the range — the same overlap rule sessions follow, so
boundary-straddling work is not dropped.

#### Scenario: Session straddles the range start
- **WHEN** a task's session started before the range and was last seen inside it
- **THEN** the task is included in the range's statistics
