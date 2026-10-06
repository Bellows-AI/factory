import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import { QUESTIONS_PER_ATTEMPT } from '../src/db/job-store-questions.js';
import type { AskedQuestion, Claim, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/** The agent's questions (050, issue #531) against a real database. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const LEASE_SECONDS = 300;
const ANSWERER = { id: '99999999-9999-4999-8999-999999999999', githubUserId: 7001, login: 'answerer' };
const CONCURRENT_ANSWERS = 10;
const QUESTION_TEXT = 'Which database?';
const ANSWERS = { [QUESTION_TEXT]: 'Postgres' };

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ANSWERER], max: 12 });

let sql: Sql;
let store: JobStore;
let otherOrgStore: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

const asked = (text = QUESTION_TEXT): AskedQuestion[] => [
    { question: text, header: 'Pick', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
];

/** A running job under a live lease — the only state a question can be asked in. */
async function running(): Promise<{ id: string; claim: Claim }> {
    const ref = await store.create('ask me things', null, { repo: null, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await store.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

const ask = (id: string, token: string, questionId: string, questions = asked()) =>
    store.askQuestion(id, token, { questionId, questions });

const expireLease = (id: string) => sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

const stateOf = async (id: string, questionId: string) =>
    (
        await sql<
            { state: string }[]
        >`select state from job_question where job_id = ${id} and question_id = ${questionId}`
    )[0]?.state;

describe.skipIf(!enabled)('job questions — database', () => {
    it('stores a pending question and reads it back on the thread and the job', async () => {
        const { id, claim } = await running();

        const result = await ask(id, claim.leaseToken, 'toolu_1');

        expect(result).toMatchObject({ result: 'created', question: { id: 'toolu_1', attempt: 1, status: 'pending' } });
        const [job] = (await store.thread(id))!;
        expect(job!.questions).toEqual([
            expect.objectContaining({
                id: 'toolu_1',
                attempt: 1,
                questions: asked(),
                status: 'pending',
                answerable: true,
                answers: null,
                answeredBy: null,
                answeredAt: null,
            }),
        ]);
        expect((await store.get(id))!.questions).toHaveLength(1);
    });

    it('is idempotent on (job, questionId) and capped at 5 per attempt', async () => {
        const { id, claim } = await running();

        const first = await ask(id, claim.leaseToken, 'toolu_1');
        const again = await ask(id, claim.leaseToken, 'toolu_1', asked('A different text?'));
        expect(first.result).toBe('created');
        expect(again).toMatchObject({ result: 'existing', question: { questions: asked() } });

        for (let n = 2; n <= QUESTIONS_PER_ATTEMPT; n++) {
            expect((await ask(id, claim.leaseToken, `toolu_${n}`)).result).toBe('created');
        }
        expect(await ask(id, claim.leaseToken, 'toolu_6')).toEqual({ result: 'limit' });
        // A repeat of a stored one still answers after the cap — idempotence beats the limit.
        expect((await ask(id, claim.leaseToken, 'toolu_1')).result).toBe('existing');
        expect((await store.get(id))!.questions).toHaveLength(QUESTIONS_PER_ATTEMPT);
    });

    it('cannot overshoot the cap when asks race', async () => {
        const { id, claim } = await running();

        const results = await Promise.all(
            Array.from({ length: CONCURRENT_ANSWERS }, (_, n) => ask(id, claim.leaseToken, `toolu_${n}`))
        );

        expect(results.filter((r) => r.result === 'created')).toHaveLength(QUESTIONS_PER_ATTEMPT);
        expect(results.filter((r) => r.result === 'limit')).toHaveLength(CONCURRENT_ANSWERS - QUESTIONS_PER_ATTEMPT);
    });

    it('fences the report to the lease: lost for a stale token, missing for an unknown job', async () => {
        const { id } = await running();
        const stale = '33333333-3333-4333-8333-333333333333';

        expect(await ask(id, stale, 'toolu_1')).toEqual({ result: 'lost' });
        expect(await ask('00000000-0000-4000-8000-000000000000', stale, 'toolu_1')).toEqual({ result: 'missing' });
        expect((await store.get(id))!.questions).toEqual([]);
    });

    it('lands an answer exactly once when 10 concurrent answers race', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');

        const results = await Promise.all(
            Array.from({ length: CONCURRENT_ANSWERS }, () => store.answerQuestion(id, 'toolu_1', ANSWERS, ANSWERER.id))
        );

        expect(results.filter((r) => r.result === 'ok')).toHaveLength(1);
        const losers = results.filter((r) => r.result !== 'ok');
        expect(losers).toHaveLength(CONCURRENT_ANSWERS - 1);
        for (const loser of losers) expect(loser).toMatchObject({ result: 'refused', reason: 'answered' });
        const [question] = (await store.get(id))!.questions;
        expect(question).toMatchObject({
            status: 'answered',
            answerable: false,
            answers: ANSWERS,
            answeredBy: { id: ANSWERER.id, login: ANSWERER.login },
        });
        expect(question!.answeredAt).not.toBeNull();
    });

    it('carries the stored answer and answerer on the second answer’s refusal', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await store.answerQuestion(id, 'toolu_1', ANSWERS, ANSWERER.id);

        const second = await store.answerQuestion(id, 'toolu_1', { [QUESTION_TEXT]: 'SQLite' }, null);

        expect(second).toMatchObject({
            result: 'refused',
            reason: 'answered',
            question: { answers: ANSWERS, answeredBy: { id: ANSWERER.id } },
        });
    });

    it('refuses an answer whose key set is not the stored question texts', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');

        for (const answers of [{}, { 'Another?': 'x' }, { ...ANSWERS, 'Extra?': 'x' }]) {
            expect(await store.answerQuestion(id, 'toolu_1', answers, null)).toMatchObject({ result: 'invalid' });
        }
        expect(await stateOf(id, 'toolu_1')).toBe('pending');
    });

    it('answers unknown for a missing question and for another org’s job', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');

        expect(await store.answerQuestion(id, 'toolu_nope', ANSWERS, null)).toEqual({ result: 'unknown' });
        expect(await otherOrgStore.answerQuestion(id, 'toolu_1', ANSWERS, null)).toEqual({ result: 'unknown' });
        expect(await stateOf(id, 'toolu_1')).toBe('pending');
    });

    it('refuses an answer to a question of an older attempt after a reclaim (question_closed)', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await expireLease(id);
        const second = (await store.claim('w2', LEASE_SECONDS)) as Claim;
        expect(second.leaseToken).not.toBe(claim.leaseToken);

        expect(await store.answerQuestion(id, 'toolu_1', ANSWERS, null)).toEqual({
            result: 'refused',
            reason: 'closed',
        });
        expect(await stateOf(id, 'toolu_1')).toBe('pending');
    });

    it('refuses an answer after a stop request (question_closed)', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        expect(await store.stop(id, null)).toMatchObject({ result: 'requested' });

        expect(await store.answerQuestion(id, 'toolu_1', ANSWERS, null)).toEqual({
            result: 'refused',
            reason: 'closed',
        });
    });

    it('refuses an answer once the run has ended (question_closed)', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await store.complete(id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });

        expect(await store.answerQuestion(id, 'toolu_1', ANSWERS, null)).toEqual({
            result: 'refused',
            reason: 'closed',
        });
    });

    it('derives closed on read and never writes it', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await expireLease(id);
        await store.claim('w2', LEASE_SECONDS);

        const [question] = (await store.get(id))!.questions;

        expect(question).toMatchObject({ status: 'closed', answerable: false });
        expect(await stateOf(id, 'toolu_1')).toBe('pending');
    });

    it('expires a pending question, and answers expired afterwards', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');

        expect(await store.expireQuestion(id, claim.leaseToken, 'toolu_1')).toEqual({ result: 'expired' });
        expect(await store.expireQuestion(id, claim.leaseToken, 'toolu_1')).toEqual({ result: 'expired' });
        expect(await store.answerQuestion(id, 'toolu_1', ANSWERS, null)).toEqual({
            result: 'refused',
            reason: 'expired',
        });
        expect((await store.get(id))!.questions[0]).toMatchObject({ status: 'expired', answerable: false });
    });

    it('answers an expiry with the answer when the answer committed first', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await store.answerQuestion(id, 'toolu_1', ANSWERS, ANSWERER.id);

        expect(await store.expireQuestion(id, claim.leaseToken, 'toolu_1')).toEqual({
            result: 'answered',
            answers: ANSWERS,
        });
        expect(await stateOf(id, 'toolu_1')).toBe('answered');
    });

    it('resolves a racing expire and answer to whichever committed, consistently', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');

        const [expired, answered] = await Promise.all([
            store.expireQuestion(id, claim.leaseToken, 'toolu_1'),
            store.answerQuestion(id, 'toolu_1', ANSWERS, null),
        ]);

        const final = await stateOf(id, 'toolu_1');
        if (final === 'answered') {
            expect(answered.result).toBe('ok');
            expect(expired).toEqual({ result: 'answered', answers: ANSWERS });
        } else {
            expect(final).toBe('expired');
            expect(expired).toEqual({ result: 'expired' });
            expect(answered).toEqual({ result: 'refused', reason: 'expired' });
        }
    });

    it('fences the expiry: lost under a stale lease, unknown for a question that was never asked', async () => {
        const { id, claim } = await running();

        expect(await store.expireQuestion(id, claim.leaseToken, 'toolu_nope')).toEqual({ result: 'unknown' });
        expect(await store.expireQuestion(id, '33333333-3333-4333-8333-333333333333', 'toolu_nope')).toEqual({
            result: 'lost',
        });
        expect(
            await store.expireQuestion('00000000-0000-4000-8000-000000000000', claim.leaseToken, 'toolu_nope')
        ).toEqual({ result: 'missing' });
    });

    it('hands the heartbeat only the answered questions of its own lease', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_old');
        await ask(id, claim.leaseToken, 'toolu_pending');
        await store.answerQuestion(id, 'toolu_old', ANSWERS, null);
        expect((await store.heartbeat(id, claim.leaseToken, LEASE_SECONDS)).answeredQuestions).toEqual([
            { questionId: 'toolu_old', answers: ANSWERS },
        ]);

        await expireLease(id);
        const second = (await store.claim('w2', LEASE_SECONDS)) as Claim;
        await ask(id, second.leaseToken, 'toolu_new');
        await store.answerQuestion(id, 'toolu_new', { [QUESTION_TEXT]: 'SQLite' }, null);

        const beat = await store.heartbeat(id, second.leaseToken, LEASE_SECONDS);
        expect(beat.answeredQuestions).toEqual([{ questionId: 'toolu_new', answers: { [QUESTION_TEXT]: 'SQLite' } }]);
        expect(await store.heartbeat(id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            result: 'lost',
            answeredQuestions: [],
        });
    });

    it('lists every question of the thread on its own run, oldest first', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_b');
        await ask(id, claim.leaseToken, 'toolu_a');

        const [job] = (await store.thread(id))!;

        expect(job!.questions.map((q) => q.id)).toEqual(['toolu_b', 'toolu_a']);
    });

    it('flags needsAnswer on the task summary while a question is answerable, and clears it after', async () => {
        const { id, claim } = await running();
        const tasks = async () =>
            (await store.listTasks({ state: 'attention', sort: 'newest', limit: 10 })).page.items.find(
                (task) => task.id === id
            );
        expect((await tasks())!.needsAnswer).toBe(false);

        await ask(id, claim.leaseToken, 'toolu_1');
        expect((await tasks())!.needsAnswer).toBe(true);

        await store.answerQuestion(id, 'toolu_1', ANSWERS, null);
        expect((await tasks())!.needsAnswer).toBe(false);
    });

    it('does not flag needsAnswer for a closed question', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await expireLease(id);
        await store.claim('w2', LEASE_SECONDS);

        const page = (await store.listTasks({ state: 'attention', sort: 'newest', limit: 10 })).page;

        expect(page.items.find((task) => task.id === id)!.needsAnswer).toBe(false);
    });

    it('deletes the questions with the thread', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await store.complete(id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });

        await store.removeThread(id, null);

        const rows = await sql`select 1 from job_question where job_id = ${id}`;
        expect(rows).toHaveLength(0);
    });
});
