---
name: review
description: Ask an independent, named reviewer to review your work in a separate run, then read its findings and verdict. Use before you finish, whenever the repository requires a review, or when you want fresh eyes on your changes. Requires BELLOWS_CONTROL_URL and BELLOWS_CONTROL_TOKEN to be set.
---

# Independent review

A reviewer is a separate run with its own instructions, its own access and its own time budget. It
reads a frozen copy of your tree — exactly as it stands when you ask — so you can keep working while
it runs. It cannot see your session or publish anything, and it is told to change nothing: its
findings are the only thing it hands back. The repository declares
which reviewers exist, by name, under `reviewers:` in `.bellows.yaml`; read that file to see them.

## Asking for a review

Pick a short key for this review (letters, digits, `_`, `-`; up to 64) and a reviewer name:

```bash
curl -sf -X POST "$BELLOWS_CONTROL_URL/review" \
    -H "authorization: Bearer $BELLOWS_CONTROL_TOKEN" \
    -d '{"key":"security-1","profile":"security"}'
```

Commit or leave your work in the tree first: the review covers the tree as it is at this moment.
The answer is JSON with `status`, `done`, `verdict` (`clean`, `blockers` or `none`), `findings`,
`revision` and `approved`. `201` means a new review started; `200` means that key already had one
and this is it — asking again with the same key never starts a second review, which is also what
makes a resumed task safe.

## Reading the result

A review is not finished until `done` is `true`. Poll the key until it is:

```bash
curl -sf "$BELLOWS_CONTROL_URL/review/security-1" \
    -H "authorization: Bearer $BELLOWS_CONTROL_TOKEN"
```

- `verdict: "clean"` — the reviewer found no blockers in the tree it was given.
- `verdict: "blockers"` — `findings` lists them, one per line: the file, the defect, what a fix
  must do. Fix them, then ask again under a NEW key; the old review stays as the record of what was
  found.
- `verdict: "none"` with `done: true` — the review failed, was stopped or ran out of time
  (`failureKind` and `status` say which). No verdict is not approval; ask again under a new key.
- `approved: true` — the repository's review policy is satisfied by the latest review. It turns
  `false` again if you change the tree after the reviewed revision, and a review of an older tree
  never counts for newer work. Edit after a clean verdict and you must ask again.

## Answers that are not a review

- `403` — this run may not invoke a reviewer (a reviewer's own run, for one).
- `409` with a reason — refused: the name is not declared in the repository, this task walks a
  workflow graph that reviews at its own step, or a request is already running. Read the reason.
- `501` — this environment cannot freeze a tree for review.
- `401` — your run is over; stop asking.

If `BELLOWS_CONTROL_URL` is unset this environment cannot invoke a reviewer. Say so; do not guess
the URL.

## Rules

- You choose the key and the reviewer name. You do not choose what is reviewed, what the reviewer
  may reach, or how long it runs — those are fixed by the repository and the board.
- Do not treat a review as the verdict on the task: it is evidence. Whether finishing is allowed is
  the repository's policy, checked by the board when you finish.
