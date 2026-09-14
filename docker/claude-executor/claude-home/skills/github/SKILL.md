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

## Pull requests are the board's, not yours

Never run `gh pr create` — the guard denies it, and the deny is policy, not an obstacle to route
around. When a task is done (work committed on the task branch, gates green), the factory board
pushes the branch and opens (or reuses) the pull request itself, with a title and description
summarized from the branch's commits by the driver's publish flow. Your job ends at committed
work.

A PR that already exists is yours to read — reviews, checks, diffs — and to fix on request,
never to create. Reading a PR's diff happens with `gh pr diff`, never by checking the branch out:
`gh pr checkout` moves HEAD off the task branch and is denied for the same reason.

## Addressing review feedback

**Read the review summary on the PR itself, not only the line comments.** The substantive
objection often lives in the summary while the line comments are details.

After pushing fixes, reply to each comment you addressed. Every reply must say *what changed and
how* — "fixed in `<sha>`" alone is useless to a reviewer:

```bash
gh pr comment <N> --body "Fixed in <sha> — clamped limit to MAX_LIMIT=100 in the validator before
the DB query, so an oversized page can no longer reach Postgres"
```

That lets the reviewer verify without re-reading the diff, and keeps the thread an accurate record
of what is still open.
