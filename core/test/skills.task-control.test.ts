import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The task-control skill is an instruction artifact: nothing it says is compiled, so the only
 * thing standing between it and a session POSTing to a route that does not exist is this file.
 * Every assertion below pins a contract the board actually serves (server/src/routes/jobs.ts and
 * job-handlers-actions.ts) — a route rename that leaves the skill behind fails here rather than
 * at someone's board.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const skill = read('../../.claude/skills/task-control/SKILL.md');
const jobsDoc = read('../../docs/jobs.md');
const agents = read('../../AGENTS.md');
const rootPackage = read('../../package.json');

describe('the task-control skill', () => {
    it('is named after its directory and says which skill it extends', () => {
        expect(skill).toMatch(/^---\nname: task-control\n/);
        expect(skill).toContain('investigate-task');
    });

    it('documents every lifecycle route the board serves', () => {
        for (const route of [
            'GET /api/repos',
            'GET /api/workspace/executors',
            'GET /api/workflows',
            'POST /api/jobs',
            'GET /api/jobs/<id>',
            'GET /api/jobs/<id>/thread',
            'POST /api/jobs/<id>/follow-up',
            'POST /api/jobs/<id>/stop',
            'POST /api/jobs/<id>/done',
            'POST /api/jobs/<id>/remove',
        ]) {
            expect(skill).toContain(route);
        }
    });

    it('invents no routes and no fields the board would ignore', () => {
        // `workflow` is a NAME on the create body; a `workflowId` create succeeds as a
        // workflow-less task, which is the silent failure worth a test.
        expect(skill).not.toContain('workflowId');
        expect(skill).not.toContain('/api/jobs/<id>/wait');
        expect(skill).not.toContain('/api/jobs/<id>/status');
        expect(skill).not.toMatch(/thread\?waitFor/);
    });

    it('waits with the settle long-poll and never with a sleep loop', () => {
        expect(skill).toContain('waitFor=terminal');
        expect(skill).toContain('1..60');
        // The board answers a timeout with the ordinary row, so the client re-issues.
        expect(skill).toContain('re-issue');
        expect(skill).not.toMatch(/^\s*sleep \d/m);
    });

    it('names the early settle, the one case where re-issuing is a request storm', () => {
        // The board settles the hold on an open workflow wait too, and answers that at once with
        // a non-terminal row. A reader who only knows "re-issue until terminal" hammers the board
        // for the whole budget.
        expect(skill).toContain('workflow wait');
        expect(skill).toContain('request storm');
    });

    it('invokes the CLI through the one npm layer that forwards a flag', () => {
        // There is no `factory` on PATH, and `npm run cli --` is itself an `npm run`: the inner
        // npm claims --timeout/--json/--yes as its own configuration, so `npm run cli -- job list
        // --limit 1` reaches the CLI as `job list 1`. One layer is the most that forwards.
        expect(skill).toContain('npm run dev -w cli -- job wait <id> --timeout');
        expect(skill).toContain('npm run dev -w cli -- job remove <id> --yes');
        expect(skill).not.toMatch(/^factory job /m);
        expect(skill).not.toMatch(/npm run cli -- job/);
    });

    it('leaves no second npm layer for the docs or the root scripts to point at', () => {
        // The two-layer spelling is what dropped the flag, so the root script that made it
        // possible is gone rather than documented around — and nothing may quietly reinstate it.
        expect(JSON.parse(rootPackage).scripts).not.toHaveProperty('cli');
        for (const doc of [jobsDoc, agents]) {
            expect(doc).toContain('npm run dev -w cli -- ');
            expect(doc).not.toMatch(/^\s*npm run cli\b/m);
        }
    });

    it('discovers the executors before it reaches the create', () => {
        // An executor name the workspace does not define fails the task at claim, not at create,
        // so discovery has to come first in the reading order too.
        const discovery = skill.indexOf('GET /api/workspace/executors');
        const create = skill.indexOf('POST /api/jobs');
        expect(discovery).toBeGreaterThan(-1);
        expect(create).toBeGreaterThan(discovery);
    });

    it('confirms with the user before the two destructive steps', () => {
        const destructive = skill.slice(skill.indexOf('POST /api/jobs/<id>/stop'));
        expect(destructive).toMatch(/confirm/i);
        expect(destructive).toContain('cannot be undone');
        expect(destructive).toContain('TASK_RUNNING');
        expect(destructive).toContain('stop it first');
    });

    it('ships generic config only — no personal host, no pasted credential', () => {
        expect(skill).toContain('FACTORY_URL');
        expect(skill).toContain('FACTORY_TOKEN');
        // The worker credential is the driver's, never a person's: it must not be offered here.
        expect(skill).not.toContain('JOB_BOARD_TOKEN');
        expect(skill).not.toMatch(/fat_[A-Za-z0-9]{8,}/);
        const hosts = skill.match(/https?:\/\/[^\s`)"]+/g) ?? [];
        expect(hosts.filter((host) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(host))).toEqual([]);
    });
});
