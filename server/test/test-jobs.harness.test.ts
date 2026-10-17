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
    // The offline board reads a plan from the bare mirror under its workspace root (issue #799):
    // every fixture write refreshes it, or the board plans from a commit the runner never sees.
    it('mirrors the origin onto the board host on every .bellows.yaml write', () => {
        const write = SCRIPT.slice(SCRIPT.indexOf('write_bellows() {'), SCRIPT.indexOf('\nwrite_bellows '));
        expect(write).toContain('mirror="$work/workspaces/.origins/$SMOKE_REPO.git"');
        expect(write).toMatch(
            /tar -C "\/workspaces\/\$member_path\/\.smoke-origin\.git" -cf - \. \| tar -C "\$mirror" -xf -/
        );
        expect(SCRIPT).toContain('ORG_WORKSPACE_ROOT="$work/workspaces"');
    });

    it('pins the open board mode instead of inheriting a developer or compose auth mode', () => {
        expect(SCRIPT).toContain('env AUTH_MODE=none DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1');
    });

    // /api/health answers while the migrations still run; the truncate needs the schema they create.
    it('waits for the migrated board, not the live one, before it touches the schema', () => {
        const boot = SCRIPT.slice(0, SCRIPT.indexOf("-c 'truncate job, workflow cascade'"));
        expect(boot).toContain('[ "$(status "$(api GET /api/ready)")" = \'200\' ]');
        expect(boot).not.toContain('api GET /api/health)")" = \'200\'');
    });

    // job_question and the batch tables reference job: a plain truncate of a named list is refused
    // by postgres the day a migration adds a referencing table, which is how the harness broke.
    it('empties every table that references a job, not a list that rots', () => {
        expect(SCRIPT).toContain("-c 'truncate job, workflow cascade'");
        expect(SCRIPT).not.toMatch(/truncate job, workflow, /);
    });

    // The route is gone from the board (404 Route not found); the claim's resumeSessionId has no
    // slash, so the legitimate field assertion cannot trip this.
    it('scripts/ holds no reference to the removed /resume route', () => {
        for (const entry of readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            expect(readFileSync(join(ROOT, 'scripts', entry.name), 'utf8')).not.toContain('/resume');
        }
    });

    it('the stop block exercises the follow-up contract', () => {
        expect(SCRIPT).toContain('202 POST "/api/jobs/$park_id/stop"');
        expect(SCRIPT).toContain('200 POST "/api/jobs/$park_id/suspend"');
        expect(SCRIPT).toContain("'a stopped job is not offered'");
        expect(SCRIPT).toContain('POST "/api/jobs/$park_id/follow-up"');
        expect(SCRIPT).not.toMatch(/standby|remoteSessionId/);
        expect(SCRIPT).toContain('resumeSessionId "$PARKED_SESSION"');
        expect(SCRIPT).toContain('followUp true');
        expect(SCRIPT).toContain('attempts 0');
    });

    it('the retry block exercises the no-session retry contract (issue #326)', () => {
        expect(SCRIPT).toContain('409 POST "/api/jobs/$retry_id/retry"');
        expect(SCRIPT).toContain('api POST "/api/jobs/$retry2_id/follow-up"');
        expect(SCRIPT).toContain('POST "/api/jobs/$retry_id/retry"');
        expect(SCRIPT).toContain('rootJobId "$retry_id"');
        expect(SCRIPT).toContain("resumeSessionId ''");
        expect(SCRIPT).toContain('followUp false');
    });

    it('truncates the queue and the workflow table before the board checks', () => {
        expect(SCRIPT.indexOf("-c 'truncate job, workflow cascade'")).toBeLessThan(
            SCRIPT.indexOf("expect_status 'stores the task-selectable executors'")
        );
    });

    it('the truncate must succeed before the queue checks run', () => {
        // Every warm-up that answered 201 queued a real job, and the truncate is the only cleanup:
        // run unchecked, a failed truncate leaves those rows — and the seeded workflow — in place,
        // and the claim checks below then fail with queue or lease symptoms instead of naming the
        // fixture as the cause. A failed truncate stops the harness.
        expect(SCRIPT).toMatch(/truncate job, workflow cascade' >\/dev\/null 2>&1 \|\| \{/);
        expect(SCRIPT).toContain("echo 'test-jobs: could not truncate job, workflow'");
    });

    // POST /api/jobs refuses a create whose repo is not the author's ready selection (#263,
    // 372f5630) — every check from 'queues a job' on failed with REPO_REQUIRED until the harness
    // seeded one. The fixture is what a finished clone leaves: the ready row, and the clone.
    it('selects a ready repository for the stand-in member before the first task', () => {
        const firstTask = SCRIPT.indexOf("create_job 'board only'");
        const seeded = SCRIPT.indexOf(
            'insert into user_repo (org_id, user_id, repo_owner, repo_name, status, ready_at)'
        );
        expect(SCRIPT).toContain('member="$(body "$(api GET /api/auth/me)")"');
        expect(seeded).toBeGreaterThan(-1);
        expect(seeded).toBeLessThan(firstTask);
        expect(SCRIPT).toContain("'ready', now())");
        expect(SCRIPT).toContain('git init -q --bare -b main .smoke-origin.git');
        expect(SCRIPT.indexOf('git clone -q "$PWD/.smoke-origin.git" "$1"')).toBeLessThan(firstTask);
    });

    it('every task the harness means to queue names the fixture repository', () => {
        expect(SCRIPT).toContain('repo: process.argv[4]');
        // The fourth argv slot of create_job's one node call is the fixture repository.
        expect(SCRIPT).toMatch(/process\.argv\[4\],.*" "\$SMOKE_REPO"\)"$/m);
        for (const command of ['x\\",\\"workflow\\":\\"ghost', 'walk me end to end', 'flag walk', 'bound walk']) {
            const at = SCRIPT.indexOf(command);
            expect(at).toBeGreaterThan(-1);
            expect(SCRIPT.slice(at, SCRIPT.indexOf('\n', at))).toContain('\\"repo\\":\\"$SMOKE_REPO\\"');
        }
        // A single-quoted body cannot carry $SMOKE_REPO: only the bodies meant to be refused before
        // the repository is read (an empty command, the unauthenticated and worker-token creates).
        const literal = [...SCRIPT.matchAll(/POST \/api\/jobs '(\{"command":[^']*\})'/g)].map((m) => m[1]);
        expect(literal.sort()).toEqual(['{"command":""}', '{"command":"echo hi"}', '{"command":"rm -rf /"}']);
    });

    it('provisions the board-issued member subpath in the named driver volume', () => {
        expect(SCRIPT).toContain('workspace_path="$(field "$fu_claim" workspacePath)"');
        expect(SCRIPT).toContain('[ "$workspace_path" = "$member_path" ]');
        expect(SCRIPT).toContain('docker volume create "$VOLUME"');
        // uid 1000: the user every runner, sync and gate container writes the tree as.
        expect(SCRIPT).toContain("mkdir -p '/workspaces/$member_path' && chown 1000:1000 '/workspaces/$member_path'");
        expect(SCRIPT.indexOf('docker volume create "$VOLUME"')).toBeLessThan(
            SCRIPT.indexOf('start_driver "$IMAGE_OK"')
        );
    });

    // The driver runs the startup sync in the job's executor image with `--entrypoint node`, so a
    // bare alpine stub cannot sync the checkout every task now has.
    it("the stub runners stand on node and git as the executor images' uid-1000 user", () => {
        const base = SCRIPT.split('\n').find((l) => l.includes('>"$work/Dockerfile.base"')) ?? '';
        expect(base).toContain('RUN apk add --no-cache git\\n');
        expect(base).toMatch(/\\nUSER node\\n' >"\$work\/Dockerfile\.base"$/);
        for (const file of ['"$work/Dockerfile.ok"', '"$work/Dockerfile.fail"', '"$work/run/Dockerfile"']) {
            const line = SCRIPT.split('\n').find((l) => l.includes(`>${file}`)) ?? '';
            expect(line).toMatch(/^printf 'FROM %s\\n/);
            expect(line).toContain(`"$IMAGE_BASE" >${file}`);
        }
        expect(SCRIPT).toContain(
            'docker image rm -f "$IMAGE_OK" "$IMAGE_FAIL" "$IMAGE_SVC" "$IMAGE_RUN" "$IMAGE_GH" "$IMAGE_BASE"'
        );
    });

    // The runner's GitHub token across a forced expiry (docs/connections.md): the lanes' mint board
    // serves the runner, the open board the driver, so the file-origin sync stays credential-free.
    it('drives the runner helper against the stand-in mint across a forced expiry', () => {
        expect(SCRIPT).toContain('node server/dist/offline-mint.js');
        expect(SCRIPT).toContain('RUNNER_STATS_URL="http://host.docker.internal:$MINT_PORT"');
        expect(SCRIPT).toContain("'a token past the renewal skew is renewed'");
        expect(SCRIPT).toContain("'no token reaches the job output'");
    });

    // The services readout reads the task worktree, which the sync branches from origin/main.
    it('the .bellows.yaml fixture is committed to the origin, not dropped into the clone', () => {
        expect(SCRIPT).toContain('git -C /tmp/tree push -q origin HEAD:main');
        expect(SCRIPT).not.toContain('/demo/.bellows.yaml');
    });

    // docker-compose.yml requires JOB_BOARD_TOKEN for the dashboard, and compose interpolates the
    // whole file on every call (on ubuntu-latest even `exec`): with no .env (a worktree, CI) the
    // postgres start and the driver build were refused.
    it('every compose call goes through the helper that can interpolate the compose file', () => {
        expect(SCRIPT).toContain('compose() { JOB_BOARD_TOKEN="$COMPOSE_TOKEN" docker compose "$@"; }');
        const code = SCRIPT.split('\n').filter((l) => !l.trimStart().startsWith('#'));
        expect(code.filter((l) => l.includes('docker compose'))).toEqual([
            'compose() { JOB_BOARD_TOKEN="$COMPOSE_TOKEN" docker compose "$@"; }',
        ]);
        expect(SCRIPT).toContain('compose -p "$COMPOSE_PROJECT" build driver');
        expect(SCRIPT).toContain('    -e JOB_BOARD_TOKEN= \\\n');
    });

    // The auth phase takes the open board down; the question round trip after it queues on $BASE.
    it('the open board is back up before the phases that follow the auth one', () => {
        const restart = SCRIPT.lastIndexOf('start_open_board\n');
        expect(restart).toBeGreaterThan(SCRIPT.indexOf("ok 'a worker token cannot queue a job'"));
        expect(restart).toBeLessThan(SCRIPT.lastIndexOf('ask_roundtrip_lane'));
    });

    // The bridge the claude entrypoint execs refuses any argv not ending in `-p <prompt>` (#536).
    it('the real-claude lanes pass the prompt last, as the driver does', () => {
        expect(SCRIPT).toContain(
            "--dangerously-skip-permissions --model fake-model\n            -p 'touch the step markers')"
        );
        expect(SCRIPT).toContain("--dangerously-skip-permissions --model fake-model -p 'ask which colour' >");
        expect(SCRIPT).not.toMatch(/"\$image" -p '/);
    });

    // opencode's abort exit is the entrypoint's to map (docker/opencode-executor/entrypoint.sh):
    // both CLIs exit 0 after a Stop, and never by the timeout.
    it('the cooperative-Stop lane wants exit 0 from both CLIs', () => {
        expect(SCRIPT).toContain('if [ "$status" = 0 ]; then\n        ok "$cli exits on its own after the stop"');
        expect(SCRIPT).not.toContain('want_exit');
    });

    // The opencode message is the turn context, then the prompt (#518): the stub's final line.
    it('the opencode check reads the prompt off the message end, not the argv head', () => {
        expect(SCRIPT).not.toContain("'run --agent factory opencode prompt'");
        expect(SCRIPT).toContain('[ "$oc_last" = \'opencode prompt\' ]');
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

    // Issue #796: the node-disruption recovery pinned offline, on a real driver and real containers.
    it('the node-disruption phase kills and drains a real driver mid-run, then adopts its runner', () => {
        const start = SCRIPT.indexOf("echo '# node disruption'");
        expect(start).toBeGreaterThan(SCRIPT.indexOf("echo '# orphan reaper'"));
        expect(start).toBeLessThan(SCRIPT.indexOf("echo '# workflows'"));
        const phase = SCRIPT.slice(start, SCRIPT.indexOf("echo '# workflows'"));
        expect(phase).toContain('--filter "label=factory.claim-seq=1"');
        expect(phase).toContain('kill -9 "$driver_pid"');
        expect(phase).toContain('kill -TERM "$driver_pid"');
        expect(phase).toContain('DRIVER_HANDOVER_MS=2000');
        expect(phase).toContain("'the driver was drained'");
        expect(phase).toContain("'adopted the finished runner of claim 1, whose driver was lost'");
        expect(phase).toContain('attempts 1');
    });

    // Issue #822: an expired lease is the lost attempt's interruption, at max_attempts 1, and a
    // driver lost together with its runner is redone by a replacement in the lost session.
    it('the node-disruption phase recovers an expiry at the last attempt, and a runner lost with its driver', () => {
        const start = SCRIPT.indexOf("echo '# node disruption'");
        const phase = SCRIPT.slice(start, SCRIPT.indexOf("echo '# workflows'"));
        expect(phase).toContain("EXPIRED='the lease expired: its driver went silent'");
        expect(phase).toContain("update job set max_attempts = 1 where id = '$killed'");
        expect(phase).toContain("update job set max_attempts = 1 where id = '$lost'");
        expect(phase).toContain('docker ps -aq --filter "label=factory.job=$lost" |');
        expect(phase).toContain('"job $lost: attempt 1 resuming session $lost_session"');
        expect(phase).toContain('upstream:0');
    });

    it('the orphan runner is removed one id at a time, not as one newline-joined argument', () => {
        // `docker rm -f "$(docker ps -aq …)"` hands every match to docker as ONE argument: with
        // more than one container left under the job label (the fence's runner plus anything the
        // reaper window missed), docker refuses the newline-joined list, the suppressed error
        // changes nothing, and the fleet stays on the daemon. The read loop removes each id on
        // its own and skips the empty match of a clean daemon.
        expect(SCRIPT).not.toContain('docker rm -f "$(docker ps -aq --filter "label=factory.job=$orphan")"');
        expect(SCRIPT).toContain('docker ps -aq --filter "label=factory.job=$orphan" |');
        expect(SCRIPT).toContain('while IFS= read -r container_id; do');
        expect(SCRIPT).toContain('[ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1');
    });
});
