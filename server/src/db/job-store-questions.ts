/**
 * The agent's questions (050, issue #531): the worker's report and expiry, the member's answer, the
 * heartbeat's delivery list and the thread reads' shape. Question text and answers are member
 * content: nothing here logs them.
 */

import type { Sql, TransactionSql } from 'postgres';
import type { UserRef } from '@factory-ai/core';
import { exists, userRef } from './job-store-rows.js';
import type {
    AnswerQuestionResult,
    AskedQuestion,
    AskQuestionResult,
    ExpireQuestionResult,
    JobQuestion,
    JobStoreContext,
} from './job-store-types.js';

/** How many question rows one attempt may hold; the next ask is refused. */
export const QUESTIONS_PER_ATTEMPT = 5;

type Answers = Record<string, string>;

interface QuestionRow {
    job_id: string;
    question_id: string;
    attempt: number;
    questions: AskedQuestion[];
    state: 'pending' | 'answered' | 'expired';
    answers: Answers | null;
    asked_at: Date;
    answered_at: Date | null;
    answerable: boolean;
    answerer_id: string | null;
    answerer_login: string | null;
    answerer_name: string | null;
    answerer_avatar_url: string | null;
}

// `answerable` is the answer UPDATE's own condition, written once more as a read: the pending row
// whose attempt still holds the job's running lease with no stop requested. A pending row that
// fails it reads `closed` — computed here, never written.
const questionSelect = (sql: Sql | TransactionSql) => sql`
    select q.job_id, q.question_id, q.attempt, q.questions, q.state, q.answers, q.asked_at, q.answered_at,
           (q.state = 'pending' and j.status = 'running' and j.lease_token = q.lease_token
               and j.cancel_requested_at is null) as answerable,
           au.id as answerer_id, au.github_login as answerer_login, au.display_name as answerer_name,
           au.avatar_url as answerer_avatar_url
    from job_question q
    join job j on j.org_id = q.org_id and j.id = q.job_id
    left join app_user au on au.id = q.answered_by
`;

function toQuestion(row: QuestionRow): JobQuestion {
    const answerer: UserRef | null = userRef(
        row.answerer_id,
        row.answerer_login,
        row.answerer_name,
        row.answerer_avatar_url
    );
    return {
        id: row.question_id,
        attempt: row.attempt,
        questions: row.questions,
        status: row.state === 'pending' && !row.answerable ? 'closed' : row.state,
        answerable: row.answerable,
        answers: row.answers,
        answeredBy: answerer,
        askedAt: row.asked_at.toISOString(),
        answeredAt: row.answered_at ? row.answered_at.toISOString() : null,
    };
}

async function readQuestion(
    sql: Sql | TransactionSql,
    orgId: string,
    jobId: string,
    questionId: string
): Promise<JobQuestion | null> {
    const [row] = await sql<QuestionRow[]>`
        ${questionSelect(sql)}
        where q.org_id = ${orgId} and q.job_id = ${jobId} and q.question_id = ${questionId}
    `;
    return row ? toQuestion(row) : null;
}

/** The questions of each named job, oldest first — what `thread()` and `get()` attach to their rows. */
export async function questionsOfJobs(
    ctx: JobStoreContext,
    jobIds: readonly string[]
): Promise<Map<string, JobQuestion[]>> {
    const { sql, orgId } = ctx;
    const byJob = new Map<string, JobQuestion[]>();
    if (jobIds.length === 0) return byJob;
    const rows = await sql<QuestionRow[]>`
        ${questionSelect(sql)}
        where q.org_id = ${orgId} and q.job_id = any(${[...jobIds]}::uuid[])
        order by q.asked_at, q.question_id
    `;
    for (const row of rows) {
        const list = byJob.get(row.job_id) ?? [];
        list.push(toQuestion(row));
        byJob.set(row.job_id, list);
    }
    return byJob;
}

/** Every answered question of this lease token — the heartbeat's delivery list. */
export async function answeredQuestionsOf(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): Promise<{ questionId: string; answers: Answers }[]> {
    const { sql, orgId } = ctx;
    const rows = await sql<{ question_id: string; answers: Answers }[]>`
        select question_id, answers from job_question
        where org_id = ${orgId} and job_id = ${id} and lease_token = ${leaseToken} and state = 'answered'
        order by answered_at, question_id
    `;
    return rows.map((row) => ({ questionId: row.question_id, answers: row.answers }));
}

export async function askQuestionReport(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    ask: { questionId: string; questions: AskedQuestion[] }
): Promise<AskQuestionResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx): Promise<AskQuestionResult> => {
        // The lease guard and the serializer in one: the row lock makes the count below and the
        // insert one step per job, so two concurrent asks cannot both see room for the last slot.
        const [job] = await tx<{ attempts: number }[]>`
            select attempts from job
            where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
            for update
        `;
        if (!job) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        const stored = await readQuestion(tx, orgId, id, ask.questionId);
        if (stored) return { result: 'existing', question: stored };
        const [held] = await tx<{ held: number }[]>`
            select count(*)::int as held from job_question
            where org_id = ${orgId} and job_id = ${id} and attempt = ${job.attempts}
        `;
        if ((held?.held ?? 0) >= QUESTIONS_PER_ATTEMPT) return { result: 'limit' };
        await tx`
            insert into job_question (org_id, job_id, question_id, attempt, lease_token, questions)
            values (${orgId}, ${id}, ${ask.questionId}, ${job.attempts}, ${leaseToken},
                    ${tx.json(ask.questions as never)})
        `;
        const question = await readQuestion(tx, orgId, id, ask.questionId);
        return { result: 'created', question: question! };
    });
}

export async function expireQuestionReport(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    questionId: string
): Promise<ExpireQuestionResult> {
    const { sql, orgId } = ctx;
    // Pending → expired under the live lease, one statement: the row lock decides the race with a
    // concurrent answer, and whichever commits first wins.
    const moved = await sql<{ question_id: string }[]>`
        update job_question q set state = 'expired'
        from job j
        where q.org_id = ${orgId} and q.job_id = ${id} and q.question_id = ${questionId}
          and q.lease_token = ${leaseToken} and q.state = 'pending'
          and j.org_id = q.org_id and j.id = q.job_id
          and j.status = 'running' and j.lease_token = ${leaseToken}
        returning q.question_id
    `;
    if (moved[0]) return { result: 'expired' };
    const live = await sql<{ id: string }[]>`
        select id from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
    `;
    if (!live[0]) return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing' };
    const [row] = await sql<{ state: string; answers: Answers | null }[]>`
        select state, answers from job_question
        where org_id = ${orgId} and job_id = ${id} and question_id = ${questionId} and lease_token = ${leaseToken}
    `;
    if (row?.state === 'answered' && row.answers) return { result: 'answered', answers: row.answers };
    // An already-expired question answers as the retried expiry it is.
    return row ? { result: 'expired' } : { result: 'unknown' };
}

/** The answer's key set must be the stored question texts, exactly. */
function answerKeysMismatch(questions: AskedQuestion[], answers: Answers): string | null {
    const keys = Object.keys(answers);
    const texts = questions.map((entry) => entry.question);
    if (keys.length === texts.length && texts.every((text) => Object.hasOwn(answers, text))) return null;
    return 'answers must have exactly one entry per question, keyed by its text';
}

export async function answerQuestionBy(
    ctx: JobStoreContext,
    answer: { id: string; questionId: string; answers: Answers; answeredBy: string | null }
): Promise<AnswerQuestionResult> {
    const { sql, orgId } = ctx;
    const { id, questionId, answers, answeredBy } = answer;
    const [stored] = await sql<{ questions: AskedQuestion[] }[]>`
        select questions from job_question
        where org_id = ${orgId} and job_id = ${id} and question_id = ${questionId}
    `;
    if (!stored) return { result: 'unknown' };
    const mismatch = answerKeysMismatch(stored.questions, answers);
    if (mismatch !== null) return { result: 'invalid', message: mismatch };
    // ONE conditional update: pending, the job running under THIS question's lease, no stop
    // requested. A second or concurrent answer finds the state already `answered` and matches
    // nothing, so an answer lands once.
    const landed = await sql<{ question_id: string }[]>`
        update job_question q set state = 'answered', answers = ${sql.json(answers as never)},
            answered_by = ${answeredBy}, answered_at = now()
        from job j
        where q.org_id = ${orgId} and q.job_id = ${id} and q.question_id = ${questionId}
          and j.org_id = q.org_id and j.id = q.job_id
          and q.state = 'pending' and j.status = 'running' and j.lease_token = q.lease_token
          and j.cancel_requested_at is null
        returning q.question_id
    `;
    const question = await readQuestion(sql, orgId, id, questionId);
    if (!question) return { result: 'unknown' };
    if (landed[0]) return { result: 'ok', question };
    if (question.status === 'answered') return { result: 'refused', reason: 'answered', question };
    return { result: 'refused', reason: question.status === 'expired' ? 'expired' : 'closed' };
}
