---
name: github
description: Work with GitHub through the gh CLI — reading PR reviews and line comments, checking CI status, reading issues, and replying to review feedback. Use whenever a GitHub URL, PR number or issue is mentioned, or when asked to address review comments. Covers the reply-with-what-changed convention.
---

# GitHub through gh

Use `gh` for all GitHub work — issues, PRs, checks, releases. Given a GitHub URL, fetch it with
`gh` rather than guessing at the content or scraping the page.

```bash
gh pr view <N> --repo <owner/repo> --comments --json comments,reviews
gh api repos/<owner/repo>/pulls/<N>/comments   # line-level review comments
gh pr status
gh pr checks <N>
gh pr diff <N>
```

## Pull requests go through the driver

Never run `gh pr create` — the guard denies it, and the deny is policy, not an obstacle to route
around. Publishing is yours to ask for, through the driver, whenever your work is worth showing —
before the task is done too. Commit on the task branch, then:

```bash
curl -sf -X POST "$BELLOWS_CONTROL_URL/publish" \
    -H "authorization: Bearer $BELLOWS_CONTROL_TOKEN"
```

The driver pushes the branch and opens (or reuses) the pull request — a draft when it opens one —
with a title and description summarized from the branch's commits, and answers
`{"published":true,"prUrl":"…","prNumber":N,…}`. Call it again after more commits: the same pull
request is updated, never duplicated, and a retried or resumed task lands on it too. `published:
false` means there was nothing new to push. `403` means this task's workflow publishes at its own
step; `409` means a publish is already running; `502` carries the failure's reason. If
`BELLOWS_CONTROL_URL` is unset this environment cannot publish for you. A pull request is not a
finished task: keep running the gates (see the gates skill), and the board publishes again, with
the same pull request, when the task completes.

A PR that already exists is yours to read — reviews, checks, diffs — and to fix on request.
Read a PR's diff with `gh pr diff`, never by checking the branch out:
`gh pr checkout` moves HEAD off the task branch and is denied for the same reason.

## Addressing review feedback

**Read the review summary on the PR itself, not only the line comments.** The substantive
objection often lives in the summary while the line comments are details.

After pushing fixes, reply to each comment you addressed. Every reply must say *what changed and
how* — "fixed in `<sha>`" alone is not enough:

```bash
gh pr comment <N> --body "Fixed in <sha> — clamped limit to MAX_LIMIT=100 in the validator before
the DB query, so an oversized page can no longer reach Postgres"
```
