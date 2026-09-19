import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The jobs harness (scripts/test-jobs.sh) only runs where a docker daemon lives, so nothing in
 * `npm test` executes it — which is how it rotted against the board: six checks kept calling the
 * /resume route the follow-up rework removed, and the teardown sweeps counted every factory.job
 * container on the daemon. These pins are the bytes the harness must carry to stay on the board's
 * HTTP contract (docs/jobs.md: every resumed claim is a follow-up now; there is no park resume)
 * and to stay scoped to the jobs this run created, the same file-pinning the executor-image
 * suites do for bytes that only ship in a container.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

describe('the test-jobs harness', () => {
    // The route is gone from the board (404 Route not found); the claim's resumeSessionId has no
    // slash, so the legitimate field assertion cannot trip this.
    it('scripts/ holds no reference to the removed /resume route', () => {
        for (const entry of readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            expect(readFileSync(join(ROOT, 'scripts', entry.name), 'utf8')).not.toContain('/resume');
        }
    });

    it('the standby block exercises the follow-up contract', () => {
        expect(SCRIPT).toContain('POST "/api/jobs/$park_id/suspend"');
        expect(SCRIPT).toContain('POST "/api/jobs/$park_id/stop"');
        expect(SCRIPT).toContain("'a parked job is not offered'");
        expect(SCRIPT).toMatch(/409 POST "\/api\/jobs\/\$park_id\/follow-up"/);
        expect(SCRIPT.split('POST "/api/jobs/$park_id/follow-up"').length - 1).toBeGreaterThanOrEqual(2);
        expect(SCRIPT).toContain('resumeSessionId "$PARKED_SESSION"');
        expect(SCRIPT).toContain('followUp true');
        expect(SCRIPT).toContain('attempts 0');
    });

    it('the truncate waits for the seeded workflow, proven by the refusal body, not the 400 alone', () => {
        // seedBase() fires un-awaited at runtime build (orgs.ts), so a one-shot warm-up gates
        // nothing: a NAMED create answers 404 UNKNOWN_WORKFLOW while `fix-issue` is still missing
        // and 400 once SOME row answers — but a stale row refuses 400 too: an older boot's
        // entry-less definition comes back BAD_WORKFLOW "workflow has no entry node" (jobs.ts),
        // indistinguishable from the fresh seed by status. Only the body — BAD_WORKFLOW_PARAMS
        // carrying the missing "issue" refusal the current template answers with — proves the
        // row this build ships has landed; anything else keeps polling, and a seed that never
        // lands stops the run instead of truncating into a repopulating table.
        expect(SCRIPT).toContain(
            `warm="$(api POST /api/jobs '{"command":"warm the org runtime","workflow":"fix-issue"}')"`
        );
        expect(SCRIPT).toMatch(/\[ "\$\(status "\$warm"\)" = '400' \]/);
        // The gate is the case arm on the body — and the quotes escape in the raw JSON text:
        // the message arrives as missing required workflow parameter \"issue\". The refusal body
        // is {error,code}, so the two needles are pinned matched in either order.
        expect(SCRIPT).toMatch(
            /\*BAD_WORKFLOW_PARAMS\*'missing required workflow parameter \\"issue\\"'\*\|\*'missing required workflow parameter \\"issue\\"'\*BAD_WORKFLOW_PARAMS\*\)\s+seeded=1/
        );
        expect(SCRIPT).toContain('the seeded workflow never landed; refusing to truncate');
        expect(SCRIPT.indexOf('warm="$(api POST /api/jobs')).toBeLessThan(SCRIPT.indexOf('truncate job, workflow'));
    });

    it('the truncate must succeed before the queue checks run', () => {
        // Every warm-up that answered 201 queued a real job, and the truncate is the only cleanup:
        // run unchecked, a failed truncate leaves those rows — and the seeded workflow — in place,
        // and the claim checks below then fail with queue or lease symptoms instead of naming the
        // fixture as the cause. A failed truncate stops the harness.
        expect(SCRIPT).toMatch(/truncate job, workflow' >\/dev\/null 2>&1 \|\| \{/);
        expect(SCRIPT).toContain("echo 'test-jobs: could not truncate job, workflow'");
        // No bare statement: the truncate line must carry the guard, not end there.
        expect(SCRIPT).not.toMatch(/'truncate job, workflow' >\/dev\/null 2>&1\n/);
    });

    it('the leftover checks are scoped to the jobs this run created', () => {
        // create_job runs inside a command-substitution subshell, so an assignment there would be
        // thrown away — the ids have to survive through the $work tempdir file the sweep reads.
        expect(SCRIPT).toContain('printf \'%s\\n\' "$id" >>"$work/created-jobs"');
        expect(SCRIPT).toContain('for job in $(cat "$work/created-jobs" 2>/dev/null)');
        expect(SCRIPT).toContain('--filter "label=factory.job=$job"');
        expect(SCRIPT).toContain('--filter "name=factory-job-$job-"');
        // The negatives guard the historical daemon-global forms this fix removed; a differently
        // written global sweep would need its own pin.
        expect(SCRIPT).not.toContain('--filter label=factory.job ');
        expect(SCRIPT).not.toContain('--filter name=factory-job- ');
    });
});
