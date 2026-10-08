import { parseArgs } from 'node:util';
import { BoardError, createBoardClient, isTerminal } from './board.js';
import type { BoardClient, BoardJobRecord } from './board.js';
import { CliConfigError, loadCliConfig } from './config.js';
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
 * arrays, and `index.ts` stays a three-line shim.
 */

const EXIT_OK = 0;
/** The board refused, or could not be reached. */
const EXIT_FAILURE = 1;
/** Bad usage or configuration — nothing was sent to the board. */
const EXIT_USAGE = 2;
/**
 * A wait that ended with no terminal row — its budget ran out, or the thread settled early on
 * something a wait cannot outlast. Its own code, because "still running" is not a failure: a
 * script that cannot tell it from a board refusal ends up reporting healthy tasks as broken.
 */
const EXIT_UNSETTLED = 3;

/** The list limit bounds the board itself enforces, mirrored so an obvious typo never round-trips. */
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 200;

/** How long one wait holds for by default, and the longest single hold the board allows. */
const WAIT_TOTAL_DEFAULT_S = 300;
const WAIT_POLL_MAX_S = 60;
const MS_PER_SECOND = 1000;
/**
 * How much of its hold a poll must have spent to count as a board timeout rather than an early
 * settle. A fraction, not a fixed slack: a slack would be dead at the one-second hold the last
 * moments of a budget ask for, which is exactly where a storm would still be free. The board
 * returns at its deadline, so the real gap is scheduling and network; an early settle answers
 * within one 250ms store poll, nowhere near half.
 */
const SETTLE_EARLY_FRACTION = 0.5;

export const USAGE = `usage: factory job create <command...> [--repo owner/name] [--executor name] [--executor-scope user|org]
                          [--skill name]...
       factory job list [--status <status>] [--limit <n>] [--repo owner/name] [--json]
       factory job investigate <id> [--json]
       factory job wait <id> [--timeout <seconds>] [--json]
       factory job follow-up <id> <command...>
       factory job stop <id>
       factory job done <id>
       factory job remove <id> --yes

config:
  FACTORY_URL    the board's base URL (required)
  FACTORY_TOKEN  a personal access token (fat_...) minted from the settings page;
                 omit it against an open (AUTH_MODE=none) board

exit codes: 0 ok, 1 the board refused or was unreachable, 2 usage,
            3 a wait ended with no terminal row (still running, or parked)

'--' ends option parsing, so a create command that takes flags of its own can follow it:
  factory job create --repo owner/name -- npm test --watch`;

/** An argument problem: the command line, not the board, is what refused. */
class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface RunIo {
    env: NodeJS.ProcessEnv;
    fetch?: typeof globalThis.fetch | undefined;
    /** The clock the wait's deadline is measured on — injected so tests spend no real time. */
    now?: (() => number) | undefined;
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

/** Config and client in one step: every command needs both, and neither takes an argument. */
function boardFor(io: RunIo): BoardClient {
    const config = loadCliConfig(io.env);
    return createBoardClient({ url: config.url, token: config.token, fetch: io.fetch });
}

/** The one positional every action command takes, and nothing else. */
function onlyId(args: readonly string[], verb: string, options: Record<string, { type: 'boolean' }> = {}) {
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options }));
    if (parsed.positionals.length !== 1) {
        throw new UsageError(`${verb} needs exactly one job id\n\n${USAGE}`);
    }
    return { id: parsed.positionals[0]!, values: parsed.values };
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

async function runCreate(args: readonly string[], io: RunIo): Promise<number> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                repo: { type: 'string' },
                executor: { type: 'string' },
                'executor-scope': { type: 'string' },
                skill: { type: 'string', multiple: true },
            },
        })
    );
    const command = parsed.positionals.join(' ').trim();
    if (!command) {
        throw new UsageError('a create needs a command\n\n' + USAGE);
    }
    const executorScope = parseExecutorScope(parsed.values['executor-scope']);
    const created = await boardFor(io).createJob({
        command,
        repo: parsed.values.repo,
        executor: parsed.values.executor,
        executorScope,
        skills: parsed.values.skill,
    });
    io.stdout(`${renderCreated(created)}\n`);
    return EXIT_OK;
}

async function runList(args: readonly string[], io: RunIo): Promise<number> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            options: {
                status: { type: 'string' },
                limit: { type: 'string' },
                repo: { type: 'string' },
                json: { type: 'boolean', default: false },
            },
        })
    );
    const limit = parseLimit(parsed.values.limit);
    const jobs = await boardFor(io).listJobs({
        status: parsed.values.status,
        limit,
        repo: parsed.values.repo,
    });
    if (parsed.values.json) {
        io.stdout(`${JSON.stringify(jobs, null, 2)}\n`);
        return EXIT_OK;
    }
    for (const job of jobs) io.stdout(`${renderJobLine(job)}\n`);
    return EXIT_OK;
}

async function runInvestigate(args: readonly string[], io: RunIo): Promise<number> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { json: { type: 'boolean', default: false } },
        })
    );
    if (parsed.positionals.length !== 1) {
        throw new UsageError('investigate needs exactly one job id\n\n' + USAGE);
    }
    const client = boardFor(io);
    const job = await client.getJob(parsed.positionals[0]!);
    const thread = await client.thread(parsed.positionals[0]!);
    if (parsed.values.json) {
        io.stdout(`${JSON.stringify({ job, thread }, null, 2)}\n`);
        return EXIT_OK;
    }
    io.stdout(`${renderJobDetail(job)}\n\n${renderThread(thread)}\n`);
    return EXIT_OK;
}

/**
 * The wait. Each poll is a settle long-poll the BOARD holds — a timeout comes back as the
 * ordinary row with nothing to mark it, so the status field is the loop condition and the
 * re-issue is the only thing this loop does. No sleep anywhere: the holding happens server-side,
 * and the last poll asks only for what is left of the deadline rather than the full cap.
 *
 * The board's settle is NOT "the row is terminal": it also settles on an open workflow wait, and
 * answers that one at once with a `queued`/`running` row. Re-issuing on a non-terminal row alone
 * would then spin as fast as the network allows for the whole budget, so a poll that came back
 * well before its hold elapsed ends the wait instead — the thread is parked, and nothing this
 * loop does will move it.
 */
async function runWait(args: readonly string[], io: RunIo): Promise<number> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { timeout: { type: 'string' }, json: { type: 'boolean', default: false } },
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
    let last: BoardJobRecord | null = null;
    for (;;) {
        const startedAt = now();
        const remainingMs = deadline - startedAt;
        if (remainingMs <= 0) break;
        const hold = Math.min(WAIT_POLL_MAX_S, Math.ceil(remainingMs / MS_PER_SECOND));
        last = await client.waitForJob(id, hold);
        if (isTerminal(last.status)) {
            io.stdout(parsed.values.json ? `${JSON.stringify(last, null, 2)}\n` : `${renderJobLine(last)}\n`);
            return EXIT_OK;
        }
        // A hold that ended early on a row that is not terminal is the board saying the thread
        // settled on something this wait cannot outlast — usually an open PR or review wait.
        if (now() - startedAt < hold * MS_PER_SECOND * SETTLE_EARLY_FRACTION) {
            io.stderr(
                `${last.status}, settled early with no terminal row: ${id}\n` +
                    'the thread is parked on a workflow wait, or this id is not its chain head\n'
            );
            return EXIT_UNSETTLED;
        }
    }
    io.stderr(`still ${last?.status ?? 'unsettled'} after ${total}s: ${id}\n`);
    return EXIT_UNSETTLED;
}

async function runFollowUp(args: readonly string[], io: RunIo): Promise<number> {
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true }));
    const [id, ...rest] = parsed.positionals;
    const command = rest.join(' ').trim();
    if (!id || !command) {
        throw new UsageError('a follow-up needs a job id and a command\n\n' + USAGE);
    }
    // Only the command travels: the repo, the executor and the session come from the parent.
    const created = await boardFor(io).followUp(id, command);
    io.stdout(`${renderCreated(created)}\n`);
    return EXIT_OK;
}

async function runStop(args: readonly string[], io: RunIo): Promise<number> {
    const { id } = onlyId(args, 'stop');
    io.stdout(`${renderStopped(await boardFor(io).stopJob(id))}\n`);
    return EXIT_OK;
}

async function runDone(args: readonly string[], io: RunIo): Promise<number> {
    const { id } = onlyId(args, 'done');
    io.stdout(`${renderDone(await boardFor(io).markDone(id))}\n`);
    return EXIT_OK;
}

async function runRemove(args: readonly string[], io: RunIo): Promise<number> {
    // A remove deletes the whole thread and cannot be undone, and this CLI has no prompt to ask
    // through — so the command line is where the intent has to be said out loud.
    const { id, values } = onlyId(args, 'remove', { yes: { type: 'boolean' } });
    if (!values.yes) {
        throw new UsageError('remove deletes the whole task thread and cannot be undone — pass --yes to confirm');
    }
    io.stdout(`${renderRemoved(await boardFor(io).removeJob(id))}\n`);
    return EXIT_OK;
}

function report(error: unknown, io: RunIo): number {
    if (error instanceof CliConfigError || error instanceof UsageError) {
        io.stderr(`${error.message}\n`);
        return EXIT_USAGE;
    }
    if (error instanceof BoardError) {
        // The board's message is the useful one; the code rides beside it for scripting, and a
        // network failure arrives as a BoardError with status 0 and the "cannot reach" message.
        const code = error.code ? ` [${error.code}]` : '';
        io.stderr(`error: ${error.message}${code}\n`);
        return EXIT_FAILURE;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}\n`);
    return EXIT_FAILURE;
}

/** Runs one command line to completion. Returns the process exit code; never throws. */
export async function run(argv: readonly string[], io: RunIo): Promise<number> {
    const [topic, command] = argv;
    const rest = argv.slice(2);
    try {
        if (topic !== 'job') return usage(io);
        switch (command) {
            case 'create':
                return await runCreate(rest, io);
            case 'list':
                return await runList(rest, io);
            case 'investigate':
                return await runInvestigate(rest, io);
            case 'wait':
                return await runWait(rest, io);
            case 'follow-up':
                return await runFollowUp(rest, io);
            case 'stop':
                return await runStop(rest, io);
            case 'done':
                return await runDone(rest, io);
            case 'remove':
                return await runRemove(rest, io);
            default:
                return usage(io);
        }
    } catch (error) {
        return report(error, io);
    }
}

function usage(io: RunIo): number {
    io.stderr(`${USAGE}\n`);
    return EXIT_USAGE;
}
