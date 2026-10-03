# Doc maintenance brief

Repo: `{{REPO_PATH}}` · Branch: `{{BRANCH}}` · Date: `{{DATE}}`

You own a group of documentation files. Rewrite each one in place so it is a **map to the code**,
not a retelling of it. Code and tests are the source of truth; a doc exists only to get a reader to
the right file fast.

## The target shape

```markdown
# <Area>

<One sentence: what this area is.>

| Concern | Code | Test |
| --- | --- | --- |
| <thing a reader comes looking for> | `path/to/file.ts` | `path/to/file.test.ts` |

## Invariants

- <claim no single file states> — `path/file.ts`, guarded by `path/test.ts`.
```

Caps: **60 lines** per doc; **120** only if your prompt says so for that file. Command runbooks are
exempt from the cap, not from the rules.

## Delete on sight

- Narrative explanation of how code works.
- Issue numbers (`issue #244`, `#62`) anywhere.
- History: "X is gone", "no longer", "was removed", "replaced", "used to".
- Rationale for settled decisions. Example payloads, SQL, argv, JSON bodies.
- Restated route/env/flag tables — point at `routes/*.ts`, `config.ts`, `.env.example` instead.
- Warnings about traps a test already catches — name the test; it is the enforcement.
- Anything duplicated in another doc in the same repo — leave it in one home, link from the other.

Aim for a **tenfold** reduction. If a file shrinks by less than half, you paraphrased instead of
deleting. Go again.

## Keep only these

1. **Where things live** — the table. The bulk of the doc.
2. **Cross-file invariants** — constraints no single file states (build order, parity requirements,
   re-export requirements). Name the file that breaks and the test that fails.
3. **Non-obvious operational facts** — what a command destroys, what a database name must match,
   which credential a path needs.
4. **Stated limits** — a capability deliberately absent, one line, so a reader stops looking.

Nothing else survives.

## Verification — mandatory

Every path, test name and npm script you write must exist **right now**. Check it:

- Paths: `ls` or `git ls-files` the path before you write it.
- npm scripts: grep the relevant `package.json`.
- Tests: the test file must exist and must actually cover the claim you attach it to.

Never invent a path to make a row look complete. If you cannot find the owning file for a concern,
drop the row and list it in your report.

## Rules while editing

- **Never touch code.** Documentation files only.
- **Never touch `AGENTS.md`.** It has one writer and it is not you.
- Stay inside your group. Files are singly owned; another agent is rewriting the others.
- Match house style: 4-space indent, 120-column lines, sentence-case prose.
- Rewrite in place with your editing tools. Do not produce a patch, a draft, or a new file.

## Report back (under 150 words)

- Lines before → after, per file.
- Any path or test you could not resolve, and what you did.
- Anything deleted that a human may want back — one line each, with the old file and claim.
</content>
