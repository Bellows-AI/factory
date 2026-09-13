'use strict';

/*
 * The git guard: a PreToolUse hook that denies the Bash commands which would move HEAD or
 * rewrite refs in the task worktree. The tree standing on `factory/<root>` is the driver's
 * invariant (docs/jobs.md) — the restore-mode sync refuses a wrong checkout only after the
 * damage, and the damage strands the thread (job 43379d3a, 2026-09-13). This hook exists to
 * keep threads runnable; it is a guardrail, not a security boundary — the agent is root in
 * its container, and the driver-side sync refusal stays the last line of defense.
 *
 * Lives in /usr/local/bin, not the config home: the Remote Control auth volume mounts over
 * CLAUDE_CONFIG_DIR and would shadow anything baked there. Read-only git, `git add` and
 * `git commit` stay allowed — a commit endangers no checkout, and publishing is the driver's
 * publish flow.
 */

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'dash', 'ash']);
const MAX_DEPTH = 8;

const ALLOW = { deny: false };

const denyOf = (what) => ({
    deny: true,
    reason:
        `git guard: ${what} would move HEAD or rewrite refs in the task worktree, and the ` +
        "checkout must stay on its task branch. Commit your work instead — branches, rebases " +
        'and publishing are the driver\'s job.',
});

// At i: a substitution opening ($( , <( or a backtick). Returns { body, end } — end one past
// the closing delimiter — or null when this is not a substitution.
function matchSubstitution(command, i) {
    const c = command[i];
    if (c === '`') {
        const end = command.indexOf('`', i + 1);
        return end === -1 ? null : { body: command.slice(i + 1, end), end: end + 1 };
    }
    if ((c === '$' || c === '<') && command[i + 1] === '(') {
        let depth = 0;
        for (let j = i + 1; j < command.length; j++) {
            if (command[j] === '(') depth += 1;
            else if (command[j] === ')') {
                depth -= 1;
                if (depth === 0) return { body: command.slice(i + 2, j), end: j + 1 };
            }
        }
    }
    return null;
}

// Split on operators at the top level, tracking quoting so `echo 'a && b'` stays one segment.
function splitOuter(text) {
    const segments = [];
    let buf = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\' && !inSingle) {
            buf += c + (text[i + 1] ?? '');
            i += 1;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle;
            buf += c;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            buf += c;
            continue;
        }
        if (!inSingle && !inDouble) {
            if ((c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|')) {
                segments.push(buf);
                buf = '';
                i += 1;
                continue;
            }
            if (c === ';' || c === '|' || c === '&' || c === '\n') {
                segments.push(buf);
                buf = '';
                continue;
            }
        }
        buf += c;
    }
    if (inSingle || inDouble) return { ok: false };
    segments.push(buf);
    return { ok: true, segments };
}

// Split a command into its runnable segments. Operators bind only outside quotes; the
// contents of $(…), <(…) and `…` cannot run as part of the surrounding command, so each span
// is lifted out and recursed as segments of its own. Unbalanced quoting means the command
// cannot be proven safe — { ok: false } and the caller denies.
function segmentsOf(command, depth) {
    const subs = [];
    let outer = '';
    let i = 0;
    while (i < command.length) {
        const c = command[i];
        if (c === '\\') {
            outer += c + (command[i + 1] ?? '');
            i += 2;
            continue;
        }
        if (c === "'") {
            const end = command.indexOf("'", i + 1);
            if (end === -1) return { ok: false };
            outer += command.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        const sub = matchSubstitution(command, i);
        if (sub) {
            subs.push(sub.body);
            outer += '""';
            i = sub.end;
            continue;
        }
        outer += c;
        i += 1;
    }
    const split = splitOuter(outer);
    if (!split.ok) return { ok: false };
    const segments = split.segments.map((s) => s.trim()).filter(Boolean);
    if (depth >= MAX_DEPTH) return subs.length ? { ok: false } : { ok: true, segments };
    for (const body of subs) {
        const nested = segmentsOf(body, depth + 1);
        if (!nested.ok) return { ok: false };
        segments.push(...nested.segments);
    }
    return { ok: true, segments };
}

// Whitespace tokens, quote-aware (a payload like 'git switch main' is one token) and each
// stripped of one layer of surrounding quotes.
function tokenize(segment) {
    const tokens = [];
    let buf = '';
    let has = false;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (c === '\\' && !inSingle) {
            buf += c + (segment[i + 1] ?? '');
            i += 1;
            has = true;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle;
            buf += c;
            has = true;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            buf += c;
            has = true;
            continue;
        }
        if (!inSingle && !inDouble && /\s/.test(c)) {
            if (has) tokens.push(buf);
            buf = '';
            has = false;
            continue;
        }
        buf += c;
        has = true;
    }
    if (has) tokens.push(buf);
    return tokens.map(unquote);
}

// One layer of surrounding quotes off a token; a `$'…'`/`$"…"` ANSI-C or locale string is
// the shell expands it — the payload inside is the command.
function unquote(token) {
    let t = token;
    if (t.length >= 2 && t[0] === '$' && (t[1] === "'" || t[1] === '"')) t = t.slice(1);
    if (
        t.length >= 2 &&
        ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')))
    ) {
        return t.slice(1, -1);
    }
    return t;
}

function analyze(segment, depth) {
    const tokens = tokenize(segment);
    let i = 0;
    // Leading environment assignments, `env`, and sh -c wrappers: strip and re-scan.
    for (;;) {
        if (i >= tokens.length) return ALLOW;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
            i += 1;
            continue;
        }
        if (tokens[i] === 'env') {
            i += 1;
            while (i < tokens.length && tokens[i].startsWith('-')) {
                i += tokens[i] === '-u' || tokens[i] === '--unset' ? 2 : 1;
            }
            continue;
        }
        if (SHELL_WRAPPERS.has(tokens[i]) && tokens[i + 1] && /^-\w*c\w*$/.test(tokens[i + 1])) {
            if (depth >= MAX_DEPTH) return denyOf('a command buried too deep in shell wrappers to read');
            const script = tokens[i + 2];
            if (!script) return ALLOW;
            return scan(unquote(script), depth + 1);
        }
        break;
    }
    if (tokens[i] !== 'git') return ALLOW;
    // Global options: -C/-c take a value (attached or next token), the --key=value / --key
    // value relocations follow, everything else is a bare flag.
    let k = i + 1;
    while (k < tokens.length && tokens[k].startsWith('-') && tokens[k] !== '--') {
        const t = tokens[k];
        if ((t === '-C' || t === '-c') && t.length === 2) {
            k += 2;
        } else if (/^--(git-dir|work-tree|namespace|super-prefix)=/.test(t)) {
            k += 1;
        } else if (t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--super-prefix') {
            k += 2;
        } else {
            k += 1;
        }
    }
    const verb = tokens[k];
    if (!verb || verb.startsWith('-')) return ALLOW;
    const rest = tokens.slice(k + 1);
    switch (verb) {
        case 'switch':
            return denyOf("'git switch'");
        case 'checkout': {
            if (rest.some((t) => t === '-b' || t === '-B' || t === '--orphan' || t === '-t' || t === '--track')) {
                return denyOf("'git checkout' with a branch-creating flag");
            }
            // `--` puts everything after it in pathspec land — HEAD cannot move. --ours,
            // --theirs and --stage are only valid in path mode; git refuses them with a
            // commit-ish.
            if (rest.includes('--') || rest.some((t) => t === '--ours' || t === '--theirs' || t === '--stage')) {
                return ALLOW;
            }
            return denyOf("'git checkout' of a branch or commit");
        }
        case 'worktree': {
            const sub = rest.find((t) => !t.startsWith('-'));
            return !sub || sub === 'list' ? ALLOW : denyOf(`'git worktree ${sub}'`);
        }
        case 'branch': {
            // Long forms exact; any short cluster (-dD, -avd, -M, …) carrying a mutating
            // letter. Read-only clusters (-a, -av, -vv, -qn) carry none.
            const mutating = rest.some(
                (t) =>
                    t === '--delete' ||
                    t === '--force' ||
                    t === '--move' ||
                    t === '--copy' ||
                    (/^-[^-]*$/.test(t) && /[dDmMcCf]/.test(t.slice(1))),
            );
            return mutating ? denyOf("'git branch' with a delete, rename, copy or force flag") : ALLOW;
        }
        case 'reset':
            return rest.includes('--hard') ? denyOf("'git reset --hard'") : ALLOW;
        case 'rebase':
            // Initiation is denied outright — rebasing onto the default branch is the driver
            // sync's job. The abort/quit/continue verbs only act on an in-progress rebase,
            // which the agent can no longer start; they are the repair path for a tree an
            // interrupted sync left mid-rebase.
            return rest.some((t) => t === '--abort' || t === '--quit' || t === '--continue')
                ? ALLOW
                : denyOf("'git rebase'");
        case 'merge':
            // As with rebase: --abort/--quit unwind an in-progress merge, which only the
            // driver's own sync can have started; a conflicted merge is completed by the
            // `git commit` that stays allowed.
            return rest.some((t) => t === '--abort' || t === '--quit') ? ALLOW : denyOf("'git merge'");
        default:
            return ALLOW;
    }
}

function scan(command, depth) {
    const { ok, segments } = segmentsOf(command, depth);
    if (!ok) return denyOf('a command whose quoting cannot be resolved');
    for (const segment of segments) {
        const verdict = analyze(segment, depth);
        if (verdict.deny) return verdict;
    }
    return ALLOW;
}

function decide(command) {
    if (typeof command !== 'string' || command.trim() === '') return ALLOW;
    try {
        return scan(command, 0);
    } catch {
        // Fail open — a hook that breaks runs is worse than one that misses, and the
        // driver-side sync refusal is the backstop either way.
        return ALLOW;
    }
}

// The canonical case table: [want, command]. Pinned twice — driver/test/executor-images.test.ts
// runs decide() over it offline, and the image suite (docker/claude-executor/test.sh) runs
// --selftest against the baked copy, so the table tests the bytes that actually ship.
const CASES = [
    ['deny', 'git switch main'],
    ['deny', 'git switch -c wip'],
    ['deny', 'git switch --detach HEAD~1'],
    ['deny', 'git switch'],
    ['deny', 'git checkout main'],
    ['deny', 'git checkout HEAD~1'],
    ['deny', 'git checkout 62-remove-pr-stats'],
    ['deny', 'git checkout -b feature'],
    ['deny', 'git checkout -B feature main'],
    ['deny', 'git checkout --orphan feature'],
    ['deny', 'git checkout -t origin/main'],
    ['deny', 'git checkout --track origin/main'],
    ['deny', 'git checkout -b feature -- src/a.ts'],
    ['deny', 'npm test && git switch main'],
    ['deny', 'echo hi; git checkout main'],
    ['deny', 'git status | git switch main'],
    ['deny', 'git status\ngit switch main'],
    ['deny', 'git branch feature -d'],
    ['deny', "'git' switch main"],
    ['deny', "sh -c $'git switch main'"],
    ['deny', 'git checkout -- -b'],
    ['deny', 'FOO=bar git switch main'],
    ['deny', 'env git switch main'],
    ['deny', 'env -u FOO git switch main'],
    ['deny', 'env GIT_X=1 git switch main'],
    ['deny', 'GIT_DIR=/x git switch main'],
    ['deny', 'git -C /tmp/other switch main'],
    ['deny', 'git -C/tmp/other switch main'],
    ['deny', 'git --git-dir=/tmp/other/.git switch main'],
    ['deny', 'git --git-dir /tmp/other/.git switch main'],
    ['deny', 'git --work-tree /tmp/other switch main'],
    ['deny', 'git --no-pager switch main'],
    ['deny', 'echo $(git switch main)'],
    ['deny', 'echo `git checkout main`'],
    ['deny', 'echo "$(git switch main)"'],
    ['deny', "sh -c 'git switch main'"],
    ['deny', 'bash -c "git checkout main"'],
    ['deny', 'git worktree add ../sibling'],
    ['deny', 'git worktree prune'],
    ['deny', 'git worktree remove /tmp/x'],
    ['deny', 'git worktree move /tmp/x /tmp/y'],
    ['deny', 'git worktree lock /tmp/x'],
    ['deny', 'git branch -d feature'],
    ['deny', 'git branch -D feature'],
    ['deny', 'git branch -dD feature'],
    ['deny', 'git branch -avd'],
    ['deny', 'git branch -m feature renamed'],
    ['deny', 'git branch -M feature main'],
    ['deny', 'git branch -c a b'],
    ['deny', 'git branch -C a b'],
    ['deny', 'git branch -f feature main'],
    ['deny', 'git branch --delete feature'],
    ['deny', 'git branch --force feature main'],
    ['deny', 'git branch --move feature renamed'],
    ['deny', 'git branch --copy feature copy'],
    ['deny', 'git reset --hard'],
    ['deny', 'git reset --hard HEAD~1'],
    ['deny', 'git reset --hard origin/main'],
    ['deny', 'git reset -q --hard HEAD~1'],
    ['deny', 'git rebase'],
    ['deny', 'git rebase origin/main'],
    ['deny', 'git rebase -i HEAD~3'],
    ['deny', 'git rebase --autostash main'],
    ['deny', 'git rebase --onto main HEAD~2'],
    ['deny', 'git merge'],
    ['deny', 'git merge origin/main'],
    ['deny', 'git merge --no-ff feature'],
    ['deny', 'git commit -m x && git rebase main'],
    ['allow', 'git status'],
    ['allow', 'git status --short'],
    ['allow', 'git diff'],
    ['allow', 'git log --oneline -10'],
    ['allow', 'git show HEAD'],
    ['allow', 'git add -A'],
    ['allow', 'git commit -m "a message"'],
    ['allow', 'git restore src/a.ts'],
    ['allow', 'git stash'],
    ['allow', 'git fetch origin'],
    ['allow', 'git push origin HEAD'],
    ['allow', 'git checkout -- server/src/main.ts'],
    ['allow', 'git checkout -- .'],
    ['allow', 'git checkout main -- src/a.ts'],
    ['allow', 'git checkout --ours src/a.ts'],
    ['allow', 'git checkout --theirs src/a.ts'],
    ['allow', 'git worktree'],
    ['allow', 'git worktree list'],
    ['allow', 'git worktree list --porcelain'],
    ['allow', 'git branch'],
    ['allow', 'git branch -a'],
    ['allow', 'git branch -av'],
    ['allow', 'git branch -vv'],
    ['allow', 'git branch --list -a'],
    ['allow', 'git branch --show-current'],
    ['allow', 'git branch feature origin/main'],
    ['allow', 'git reset'],
    ['allow', 'git reset HEAD~1'],
    ['allow', 'git reset --soft HEAD~1'],
    ['allow', 'git merge --abort'],
    ['allow', 'git merge --quit'],
    ['allow', 'git rebase --abort'],
    ['allow', 'git rebase --quit'],
    ['allow', 'git rebase --continue'],
    ['allow', 'npm test'],
    ['allow', 'ls -la'],
    ['allow', "echo 'git switch main'"],
    ['allow', 'echo "git switch main"'],
    ['allow', 'grep "git switch" docs/*.md'],
    ['allow', 'git --no-pager diff'],
    ['allow', 'git --version'],
    ['allow', 'git -C /tmp/other status'],
];

module.exports = { decide, CASES };

if (require.main === module) {
    if (process.argv[2] === '--selftest') {
        let failures = 0;
        for (const [want, command] of CASES) {
            const got = decide(command).deny ? 'deny' : 'allow';
            if (got !== want) {
                failures += 1;
                console.error(`FAIL ${JSON.stringify(command)}: wanted ${want}, got ${got}`);
            }
        }
        if (failures > 0) process.exit(1);
        console.log('GUARD-TABLE-OK');
        process.exit(0);
    }
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        raw += chunk;
    });
    process.stdin.on('end', () => {
        try {
            const verdict = decide(JSON.parse(raw)?.tool_input?.command);
            if (verdict.deny) {
                process.stdout.write(
                    JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: verdict.reason,
                        },
                    }) + '\n',
                );
            }
        } catch {
            // Malformed input fails open, like decide().
        }
        process.exit(0);
    });
}
