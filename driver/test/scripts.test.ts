import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    prSummaryScript,
} from '../src/publish.js';
import { bellowsReadScript } from '../src/services.js';
import {
    BODY_MAX,
    DIFF_HUNK_MAX,
    ERROR_MAX,
    GENERAL_LIMIT,
    INLINE_LIMIT,
    PLAN_BYTES_MAX,
    PLAN_TARGETS_MAX,
    REVIEWS_LIMIT,
    THREADS_LIMIT,
    THREAD_COMMENTS_LIMIT,
    TOTAL_OUTPUT_BYTES,
    TRUNCATED_MARKER,
    reviewCollectScript,
    reviewReplyScript,
} from '../src/review.js';
import { claudeTurnsScript, opencodeCacheProbeScript, opencodeReadoutScript } from '../src/container-scripts.js';
import { HELPER_REGISTRY } from '../src/helpers.js';
import { REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID } from '../src/review-helpers.js';
import { SCRIPTS_DIR, pathOf } from './fixtures/scripts-support.js';

/**
 * The scripts this driver hands to containers are REAL FILES under `driver/src/scripts/`, read at
 * load time and passed to the container by argv — never inline template strings in the TS source,
 * and never by mounting a path (the driver has no host path into a named volume). This suite is
 * the seam between the two halves: the files must exist, must PARSE (a syntax error here is a
 * container-only failure otherwise — every runner that would have executed the script burns its
 * attempt instead), and the TS-side constants must be exactly their file's content, so a pin on a
 * constant is a pin on the artifact the container runs.
 *
 * The behavior of each script — the credential helper, the opencode/claude-turns readouts, the
 * worktree reclaim — is exercised in its own sibling file (`scripts-*.test.ts`, split out for the
 * line-count cap); this file keeps only the parity/parse checks that cover every script at once.
 */

/** Every script file, with the checker that gates its syntax. */
const FILES: [string, 'node' | 'sh'][] = [
    ['git-probe.cjs', 'node'],
    ['git-worktree.cjs', 'node'],
    ['git-worktree-remove.cjs', 'node'],
    ['pr-summary.cjs', 'node'],
    ['bellows-read.sh', 'sh'],
    ['opencode-readout.cjs', 'node'],
    ['claude-turns.cjs', 'node'],
    ['opencode-cache-probe.cjs', 'node'],
    ['credential-helper.sh', 'sh'],
    ['review-collect.cjs', 'node'],
    ['review-reply.cjs', 'node'],
    ['helper-noop.cjs', 'node'],
    ['merge-conflict-probe.cjs', 'node'],
    ['review-collect-probe-prelude.cjs', 'node'],
    ['review-collect-probe-postlude.cjs', 'node'],
    ['review-reply-probe-middle.cjs', 'node'],
    ['review-reply-probe-postlude.cjs', 'node'],
];

describe('the container scripts', () => {
    it('ships exactly the scripts the driver loads, and nothing else', () => {
        // The build copies this directory wholesale (driver/package.json), so the directory IS
        // the contract: a file here is a file in the image, and a stray one would ship too.
        expect(readdirSync(SCRIPTS_DIR).sort()).toEqual(FILES.map(([name]) => name).sort());
    });

    it.each(FILES)('%s parses', (name, runtime) => {
        const path = pathOf(name);
        expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(0);
        if (runtime === 'node') {
            // --check parses only; it executes nothing, so a script here is safe to compile-check.
            execFileSync('node', ['--check', path], { stdio: 'ignore' });
        } else if (name === 'credential-helper.sh') {
            // A gitcredentials(7) snippet, not a standalone script: the driver passes the whole
            // file as `git -c credential.helper=<content>`, and the leading `!` is what tells git
            // to run it as a shell snippet rather than look up a command. A pipeline negation is
            // the only other thing `!` can mean to a shell, so no bare `sh -n` parses the file as
            // written. Strip the marker and parse-check the shell body — the part its author
            // writes.
            const body = readFileSync(path, 'utf8').replace(/^!/, '');
            execFileSync('sh', ['-n'], { input: body, stdio: ['pipe', 'ignore', 'ignore'] });
        } else {
            execFileSync('sh', ['-n', path], { stdio: 'ignore' });
        }
    });

    // Loader parity: the constant a docker/k8s argv builder passes must be byte-identical to the
    // file on disk — otherwise the pins above guard a string nobody runs. The credential helper is
    // the exception by construction: git executes its VALUE as `sh -c '<value> <op>'`, so trailing
    // whitespace is code there, and the constant is the file TRIMMED (see publish.ts).
    it('loads every script from its file, byte for byte', () => {
        expect(gitProbeScript).toBe(readFileSync(pathOf('git-probe.cjs'), 'utf8'));
        expect(gitWorktreeScript).toBe(readFileSync(pathOf('git-worktree.cjs'), 'utf8'));
        expect(gitWorktreeRemoveScript).toBe(readFileSync(pathOf('git-worktree-remove.cjs'), 'utf8'));
        expect(prSummaryScript).toBe(readFileSync(pathOf('pr-summary.cjs'), 'utf8'));
        expect(bellowsReadScript).toBe(readFileSync(pathOf('bellows-read.sh'), 'utf8'));
        expect(opencodeReadoutScript).toBe(readFileSync(pathOf('opencode-readout.cjs'), 'utf8'));
        expect(claudeTurnsScript).toBe(readFileSync(pathOf('claude-turns.cjs'), 'utf8'));
        expect(opencodeCacheProbeScript).toBe(readFileSync(pathOf('opencode-cache-probe.cjs'), 'utf8'));
        expect(CREDENTIAL_HELPER).toBe(readFileSync(pathOf('credential-helper.sh'), 'utf8').trim());
        expect(reviewCollectScript).toBe(readFileSync(pathOf('review-collect.cjs'), 'utf8'));
        expect(reviewReplyScript).toBe(readFileSync(pathOf('review-reply.cjs'), 'utf8'));
        expect(HELPER_REGISTRY.get('noop')?.scriptBody).toBe(readFileSync(pathOf('helper-noop.cjs'), 'utf8'));
        expect(HELPER_REGISTRY.get('merge-conflict-probe')?.scriptBody).toBe(
            readFileSync(pathOf('merge-conflict-probe.cjs'), 'utf8')
        );
    });

    // The github-review-reconcile block's two helpers (issue #133) are COMPOSED bodies, never a
    // single file's content — driver/src/review-helpers.ts assembles each from real adapter files
    // plus the unmodified review-collect.cjs/review-reply.cjs, joined with the bare `{ }` blocks
    // that keep the embedded script's own top-level names from colliding with the adapter's own.
    // This pin is on the ASSEMBLY, not just the pieces: a byte drift in either adapter file, or in
    // how review-helpers.ts joins them, fails here rather than only surfacing as a container-only
    // parse or scope error.
    it('assembles the review-block helper bodies from their real files, byte for byte', () => {
        const read = (name: string): string => readFileSync(pathOf(name), 'utf8');
        const collectBody = [
            read('review-collect-probe-prelude.cjs'),
            '{',
            read('review-collect.cjs'),
            '}',
            read('review-collect-probe-postlude.cjs'),
        ].join('\n');
        expect(HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID)?.scriptBody).toBe(collectBody);

        const replyBody = [
            read('review-collect-probe-prelude.cjs'),
            '{',
            read('review-collect.cjs'),
            '}',
            read('review-reply-probe-middle.cjs'),
            'if (!__reviewReplyProbeSkip) {',
            read('review-reply.cjs'),
            '}',
            read('review-reply-probe-postlude.cjs'),
        ].join('\n');
        expect(HELPER_REGISTRY.get(REVIEW_REPLY_PROBE_ID)?.scriptBody).toBe(replyBody);
    });

    // The review scripts are not yet loaded by any argv builder, so a byte pin through a
    // (dormant) constant is the whole seam. The caps they enforce are duplicated as literals in
    // the scripts AND as the exported constants this module hands to orchestration: a cap drift
    // in either direction changes what a container truncates versus what the planner promises, so
    // the shared caps have to agree literal by literal.
    it('pins the review cap literals to the exported constants', () => {
        const capsOf = (name: string): Record<string, string> => {
            const src = readFileSync(pathOf(name), 'utf8');
            const caps: Record<string, string> = {};
            for (const m of src.matchAll(/^const ([A-Z_]+) = (.+);$/gm)) caps[m[1]!] = m[2]!;
            return caps;
        };
        const evalCap = (rhs: string): unknown => new Function(`return (${rhs})`)();
        const collect = capsOf('review-collect.cjs');
        const reply = capsOf('review-reply.cjs');
        const collectOnly: Array<[string, unknown]> = [
            ['BODY_MAX', BODY_MAX],
            ['DIFF_HUNK_MAX', DIFF_HUNK_MAX],
            ['GENERAL_LIMIT', GENERAL_LIMIT],
            ['INLINE_LIMIT', INLINE_LIMIT],
            ['REVIEWS_LIMIT', REVIEWS_LIMIT],
            ['THREADS_LIMIT', THREADS_LIMIT],
            ['THREAD_COMMENTS_LIMIT', THREAD_COMMENTS_LIMIT],
            ['TOTAL_OUTPUT_BYTES', TOTAL_OUTPUT_BYTES],
        ];
        const replyOnly: Array<[string, unknown]> = [
            ['PLAN_TARGETS_MAX', PLAN_TARGETS_MAX],
            ['PLAN_BYTES_MAX', PLAN_BYTES_MAX],
        ];
        const shared: Array<[string, unknown]> = [
            ['ERROR_MAX', ERROR_MAX],
            ['TRUNCATED_MARKER', TRUNCATED_MARKER],
        ];
        const check = (caps: Record<string, string>, name: string, value: unknown, where: string) => {
            expect(caps[name], `${name} in ${where}`).toBeDefined();
            expect(evalCap(caps[name]!), `${name} in ${where}`).toEqual(value);
        };
        for (const [name, value] of collectOnly) check(collect, name, value, 'collect');
        for (const [name, value] of replyOnly) check(reply, name, value, 'reply');
        for (const [name, value] of shared) {
            check(collect, name, value, 'collect');
            check(reply, name, value, 'reply');
        }
        expect(collect.TOTAL_OUTPUT_BYTES).toBe('262144');
        // The GraphQL thread pagination is untyped in the scripts: the collect script interpolates
        // the constant into its query, the reply script writes the resolved number; pin both to
        // THREADS_LIMIT (the collect file text is 'first: ${THREADS_LIMIT}', not the number).
        expect(readFileSync(pathOf('review-collect.cjs'), 'utf8')).toContain(`first: \${THREADS_LIMIT}`);
        expect(readFileSync(pathOf('review-reply.cjs'), 'utf8')).toContain(`first: ${THREADS_LIMIT}`);
    });

    // The credential helper runs exactly as git spawns it (gitcredentials(7)): a `!`-prefixed
    // helper value is a shell SNIPPET — git strips the bang and runs `sh -c '<snippet> <op>'` —
    // and the op is appended VERBATIM, so trailing whitespace is code. The loaded constant is
    // trimmed (see publish.ts) because the file's POSIX trailing newline would strand `get` on
    // its own line and the helper would exit 127 after answering; git only happens to keep a
    // dead helper's stdout (observed 2026-09-13, job 43379d3a: `get: 2: get: not found` in the
    // publish container). Pins the marker semantics AND the spawn shape and its exit status.
    it('the credential helper runs clean exactly as git spawns it', () => {
        expect(CREDENTIAL_HELPER.startsWith('!')).toBe(true);
        const snippet = CREDENTIAL_HELPER.slice(1);
        const run = spawnSync('sh', ['-c', `${snippet} get`], {
            env: { ...process.env, GITHUB_TOKEN: 'test-token' },
            encoding: 'utf8',
        });
        expect(run.status).toBe(0);
        expect(run.stdout).toContain('username=x-access-token');
        expect(run.stdout).toContain('password=test-token');
    });
});
