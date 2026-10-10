import { parseArgs } from 'node:util';
import { BoardError, createBoardClient, HTTP_OK, MALFORMED_RESPONSE_CODE, NO_RESPONSE_STATUS } from './board.js';
import type { BoardClient, JobWait } from './board.js';
import { CliConfigError, loadCliConfig } from './config.js';
import { INPUT_OPTIONS, InputError, resolveInput } from './input.js';
import type { InputIo } from './input.js';
import { envelopeOf, OUTCOME } from './outcome.js';
import type { CommandResult, ErrorDetail } from './outcome.js';
import {
    renderCreated,
    renderDone,
    renderJobDetail,
    renderJobLine,
    renderRemoved,
    renderStopped,
    renderThread,
} from './render.js';

/**
 * The command surface: parse, load config, call the board, print, return an exit code. Every
 * effect is injected — config from `io.env`, HTTP from `io.fetch`, output through `io.stdout` /
 * `io.stderr` — so tests run the whole CLI in-process against a recorded fetch and string
 * arrays, and `index.ts` stays a small shim.
 *
 * A command never prints: it returns a `CommandResult`, and `run` alone decides how that is shown.
 * That is what keeps `--json` clean — one envelope on stdout, nothing on stderr, for success,
 * refusal, network failure, interruption and a command line that never parsed alike. The outcome
 * and exit-code vocabulary lives in `outcome.ts`.
 */

/** The list limit bounds the board itself enforces, mirrored so an obvious typo never round-trips. */
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 200;

/** How long one wait holds for by default, and the longest single hold the board allows. */
const WAIT_TOTAL_DEFAULT_S = 300;
const WAIT_POLL_MAX_S = 60;
const MS_PER_SECOND = 1000;

const JSON_FLAG = '--json';
const END_OF_OPTIONS = '--';
const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;

export const USAGE = `usage: factory job create (<command...> | --file <path> | --stdin) [--repo owner/name] [--executor name] [--executor-scope user|org]
                          [--skill name]... [--json]
       factory job list [--status <status>] [--limit <n>] [--repo owner/name] [--json]
       factory job investigate <id> [--json]
       factory job wait <id> [--timeout <seconds>] [--json]
       factory job follow-up <id> (<command...> | --file <path> | --stdin) [--json]
       factory job stop <id> [--json]
       factory job done <id> [--json]
       factory job remove <id> --yes [--json]

config:
  FACTORY_URL    the board's base URL (required)
  FACTORY_TOKEN  a personal access token (fat_...) minted from the settings page;
                 omit it against an open (AUTH_MODE=none) board

exit codes: 0 ok (a wait: the run succeeded), 1 the board refused, 2 usage or configuration,
            3 a wait ran out of budget, 4 the run failed or died, 5 the run was stopped on the
            board, 6 the thread is parked on a workflow wait, 7 the board was unreachable,
            130 interrupted locally

--json prints one envelope on stdout and nothing on stderr, whatever the outcome:
  { ok, command, outcome, exitCode, data, error }

'--' ends option parsing, so a create command that takes flags of its own can follow it:
  factory job create --repo owner/name -- npm test --watch

--file and --stdin read the command from a file or standard input, newlines kept as written;
exactly one of positional words, --file and --stdin may be given, and the text is at most
16384 characters.`;

/** An argument problem: the command line, not the board, is what refused. */
class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface RunIo extends InputIo {
    env: NodeJS.ProcessEnv;
    fetch?: typeof globalThis.fetch | undefined;
    /** The clock the wait's budget is measured on — injected so tests spend no real time. */
    now?: (() => number) | undefined;
    /** Aborted on a local interrupt: the command ends `interrupted`, the task is left alone. */
    signal?: AbortSignal | undefined;
    stdout(text: string): void;
    stderr(text: string): void;
}

function parseOrUsage<T>(parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }
}

function parseLimit(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < LIST_LIMIT_MIN || value > LIST_LIMIT_MAX) {
        throw new UsageError(`--limit must be an integer ${LIST_LIMIT_MIN}..${LIST_LIMIT_MAX}, got "${raw}"`);
    }
    return value;
}

/** The wait's own budget, not the board's: how long to keep re-issuing, in seconds. */
function parseWaitTimeout(raw: string | undefined): number {
    if (raw === undefined) return WAIT_TOTAL_DEFAULT_S;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new UsageError(`--timeout must be a positive integer number of seconds, got "${raw}"`);
    }
    return value;
}

/** The command text of a create or follow-up; a bad source is a usage error, before any request. */
async function commandFrom(
    values: { file?: string | undefined; stdin?: boolean | undefined },
    positionals: readonly string[],
    io: RunIo
): Promise<string> {
    try {
        return await resolveInput({ positionals, file: values.file, stdin: values.stdin }, io);
    } catch (error) {
        if (error instanceof InputError) throw new UsageError(`${error.message}\n\n${USAGE}`);
        throw error;
    }
}

/** Config and client in one step: every command needs both, and neither takes an argument. */
function boardFor(io: RunIo): BoardClient {
    const config = loadCliConfig(io.env);
    return createBoardClient({ url: config.url, token: config.token, fetch: io.fetch, signal: io.signal });
}

/** The one positional every action command takes, and nothing else. */
function onlyId(args: readonly string[], verb: string, options: Record<string, { type: 'boolean' }> = {}) {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...options } })
    );
    if (parsed.positionals.length !== 1) {
        throw new UsageError(`${verb} needs exactly one job id\n\n${USAGE}`);
    }
    return { id: parsed.positionals[0]!, values: parsed.values as { json?: boolean; yes?: boolean } };
}

/**
 * The scope an executor selection names (issue 391). Absent sends nothing — the board defaults to
 * the author's personal profiles — and anything outside the pair is a usage error before any
 * request, the way a misspelled flag is.
 */
function parseExecutorScope(raw: string | undefined): 'user' | 'org' | undefined {
    if (raw === undefined) return undefined;
    if (raw !== 'user' && raw !== 'org') {
        throw new UsageError(`--executor-scope must be "user" or "org", got "${raw}"\n\n${USAGE}`);
    }
    return raw;
}

/** A command that did what it was asked: the board's payload, and its one-line rendering. */
function ok(data: unknown, text: string): CommandResult {
    return { outcome: OUTCOME.ok, data, stdout: `${text}\n` };
}

async function runCreate(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                ...JSON_OPTION,
                ...INPUT_OPTIONS,
                repo: { type: 'string' },
                executor: { type: 'string' },
                'executor-scope': { type: 'string' },
                skill: { type: 'string', multiple: true },
            },
        })
    );
    const command = await commandFrom(parsed.values, parsed.positionals, io);
    const executorScope = parseExecutorScope(parsed.values['executor-scope']);
    const created = await boardFor(io).createJob({
        command,
        repo: parsed.values.repo,
        executor: parsed.values.executor,
        executorScope,
        skills: parsed.values.skill,
    });
    return ok(created, renderCreated(created));
}

async function runList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            options: {
                ...JSON_OPTION,
                status: { type: 'string' },
                limit: { type: 'string' },
                repo: { type: 'string' },
            },
        })
    );
    const limit = parseLimit(parsed.values.limit);
    const jobs = await boardFor(io).listJobs({
        status: parsed.values.status,
        limit,
        repo: parsed.values.repo,
    });
    return { outcome: OUTCOME.ok, data: { jobs }, stdout: jobs.map((job) => `${renderJobLine(job)}\n`).join('') };
}

async function runInvestigate(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'investigate');
    const client = boardFor(io);
    const job = await client.getJob(id);
    const thread = await client.thread(id);
    return ok({ job, thread }, `${renderJobDetail(job)}\n\n${renderThread(thread)}`);
}

/** What a wait's `data` says: the result, and the task / requested run / head run identities. */
function waitData(id: string, wait: JobWait, budgetSeconds: number) {
    return {
        result: wait.result,
        taskId: wait.rootJobId,
        runId: id,
        headRunId: wait.headJobId,
        headStatus: wait.headStatus,
        waitReason: wait.waitReason,
        budgetSeconds,
        job: wait.job,
    };
}

/** How a terminal head's verdict ends the command — the run's own verdict, nothing downstream of it. */
function terminalOutcome(wait: JobWait): CommandResult['outcome'] {
    switch (wait.headStatus) {
        case 'succeeded':
            return OUTCOME.succeeded;
        case 'failed':
        case 'dead':
            return OUTCOME.failed;
        case 'stopped':
            return OUTCOME.cancelled;
        default:
            throw new BoardError(
                `the board settled a wait on a head in status "${wait.headStatus}"`,
                HTTP_OK,
                MALFORMED_RESPONSE_CODE
            );
    }
}

/**
 * The wait. Each poll is a settle long-poll the BOARD holds, and the board says why it returned:
 * `terminal` (the head's verdict is in), `parked` (an open workflow wait nothing here can move)
 * or `timeout` (the hold elapsed, thread still moving). Only a `timeout` is re-issued; nothing is
 * inferred from how long a poll took. No sleep anywhere — the holding happens server-side, and
 * the last poll asks only for what is left of the budget rather than the full cap.
 */
async function runWait(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { ...JSON_OPTION, timeout: { type: 'string' } },
        })
    );
    if (parsed.positionals.length !== 1) {
        throw new UsageError('wait needs exactly one job id\n\n' + USAGE);
    }
    const id = parsed.positionals[0]!;
    const total = parseWaitTimeout(parsed.values.timeout);
    const client = boardFor(io);
    const now = io.now ?? Date.now;

    const deadline = now() + total * MS_PER_SECOND;
    let last: JobWait | null = null;
    for (;;) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        const hold = Math.min(WAIT_POLL_MAX_S, Math.ceil(remainingMs / MS_PER_SECOND));
        last = await client.waitForJob(id, hold);
        if (last.result === 'terminal') {
            return {
                outcome: terminalOutcome(last),
                data: waitData(id, last, total),
                stdout: `${renderJobLine(last.job)}\n`,
            };
        }
        if (last.result === 'parked') {
            return {
                outcome: OUTCOME.needsAttention,
                data: waitData(id, last, total),
                stderr:
                    `${last.headStatus}, parked on a workflow wait (${last.waitReason ?? 'unnamed'}): ${id}\n` +
                    `the task's head run is ${last.headJobId}; nothing a wait does moves a parked thread\n`,
            };
        }
    }
    return {
        outcome: OUTCOME.timeout,
        data: last
            ? waitData(id, last, total)
            : { result: 'timeout', runId: id, budgetSeconds: total, taskId: null, headRunId: null },
        stderr: `still ${last?.headStatus ?? 'unsettled'} after ${total}s: ${id}\n`,
    };
}

async function runFollowUp(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...INPUT_OPTIONS } })
    );
    const [id, ...rest] = parsed.positionals;
    if (!id) {
        throw new UsageError('a follow-up needs a job id and a command\n\n' + USAGE);
    }
    const command = await commandFrom(parsed.values, rest, io);
    // Only the command travels: the repo, the executor and the session come from the parent.
    const created = await boardFor(io).followUp(id, command);
    return ok(created, renderCreated(created));
}

async function runStop(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'stop');
    const stopped = await boardFor(io).stopJob(id);
    return ok(stopped, renderStopped(stopped));
}

async function runDone(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'done');
    const done = await boardFor(io).markDone(id);
    return ok(done, renderDone(done));
}

async function runRemove(args: readonly string[], io: RunIo): Promise<CommandResult> {
    // A remove deletes the whole thread and cannot be undone, and this CLI has no prompt to ask
    // through — so the command line is where the intent has to be said out loud.
    const { id, values } = onlyId(args, 'remove', { yes: { type: 'boolean' } });
    if (!values.yes) {
        throw new UsageError('remove deletes the whole task thread and cannot be undone — pass --yes to confirm');
    }
    const removed = await boardFor(io).removeJob(id);
    return ok(removed, renderRemoved(removed));
}

const COMMANDS: Record<string, (args: readonly string[], io: RunIo) => Promise<CommandResult>> = {
    create: runCreate,
    list: runList,
    investigate: runInvestigate,
    wait: runWait,
    'follow-up': runFollowUp,
    stop: runStop,
    done: runDone,
    remove: runRemove,
};

const INTERRUPTED_MESSAGE = 'interrupted — this process stopped; the task on the board was not touched';

/** A failure as a result: which outcome it is, what to tell a person, and what to tell a script. */
function failureOf(error: unknown, io: RunIo): CommandResult {
    // A local interrupt aborts the fetch, which looks like a network failure — the signal is the
    // only thing that tells the two apart, so it is asked first.
    if (io.signal?.aborted) {
        const detail: ErrorDetail = { message: INTERRUPTED_MESSAGE, code: null, status: null };
        return { outcome: OUTCOME.interrupted, error: detail, stderr: `${INTERRUPTED_MESSAGE}\n` };
    }
    if (error instanceof CliConfigError || error instanceof UsageError) {
        return {
            outcome: OUTCOME.usage,
            error: { message: error.message, code: null, status: null },
            stderr: `${error.message}\n`,
        };
    }
    if (error instanceof BoardError) {
        // The board's message is the useful one; the code rides beside it for scripting.
        const code = error.code ? ` [${error.code}]` : '';
        return {
            outcome: error.status === NO_RESPONSE_STATUS ? OUTCOME.unreachable : OUTCOME.refused,
            error: { message: error.message, code: error.code, status: error.status },
            stderr: `error: ${error.message}${code}\n`,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        outcome: OUTCOME.refused,
        error: { message, code: null, status: null },
        stderr: `error: ${message}\n`,
    };
}

/** Whether `--json` was asked for, read before any parsing so a parse failure can still honor it. */
function wantsJson(args: readonly string[]): boolean {
    const end = args.indexOf(END_OF_OPTIONS);
    return (end === -1 ? args : args.slice(0, end)).includes(JSON_FLAG);
}

async function dispatch(
    argv: readonly string[],
    io: RunIo
): Promise<{ command: string | null; result: CommandResult }> {
    const [topic, command] = argv;
    const handler = topic === 'job' && command !== undefined ? COMMANDS[command] : undefined;
    // A line that names no command reports none, so a parse failure never invents one.
    const name = handler ? `${topic} ${command}` : null;
    try {
        if (!handler) throw new UsageError(USAGE);
        return { command: name, result: await handler(argv.slice(2), io) };
    } catch (error) {
        return { command: name, result: failureOf(error, io) };
    }
}

/** Runs one command line to completion. Returns the process exit code; never throws. */
export async function run(argv: readonly string[], io: RunIo): Promise<number> {
    const { command, result } = await dispatch(argv, io);
    const envelope = envelopeOf(command, result);
    if (wantsJson(argv)) {
        io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
        if (result.stdout) io.stdout(result.stdout);
        if (result.stderr) io.stderr(result.stderr);
    }
    return envelope.exitCode;
}
