import { parseArgs } from 'node:util';
import { BoardError, createBoardClient } from './board.js';
import { CliConfigError, loadCliConfig } from './config.js';
import { renderCreated, renderJobDetail, renderJobLine, renderThread } from './render.js';

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

/** The list limit bounds the board itself enforces, mirrored so an obvious typo never round-trips. */
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 200;

export const USAGE = `usage: factory job create <command...> [--repo owner/name] [--executor name]
       factory job list [--status <status>] [--limit <n>] [--repo owner/name] [--json]
       factory job investigate <id> [--json]

config:
  FACTORY_URL    the board's base URL (required)
  FACTORY_TOKEN  a personal access token (fat_...) minted from the settings page;
                 omit it against an open (AUTH_MODE=none) board

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

async function runCreate(args: readonly string[], io: RunIo): Promise<number> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                repo: { type: 'string' },
                executor: { type: 'string' },
            },
        })
    );
    const command = parsed.positionals.join(' ').trim();
    if (!command) {
        throw new UsageError('a create needs a command\n\n' + USAGE);
    }
    const config = loadCliConfig(io.env);
    const client = createBoardClient({ url: config.url, token: config.token, fetch: io.fetch });
    const created = await client.createJob({
        command,
        repo: parsed.values.repo,
        executor: parsed.values.executor,
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
    const config = loadCliConfig(io.env);
    const client = createBoardClient({ url: config.url, token: config.token, fetch: io.fetch });
    const jobs = await client.listJobs({
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
    const config = loadCliConfig(io.env);
    const client = createBoardClient({ url: config.url, token: config.token, fetch: io.fetch });
    const job = await client.getJob(parsed.positionals[0]!);
    const thread = await client.thread(parsed.positionals[0]!);
    if (parsed.values.json) {
        io.stdout(`${JSON.stringify({ job, thread }, null, 2)}\n`);
        return EXIT_OK;
    }
    io.stdout(`${renderJobDetail(job)}\n\n${renderThread(thread)}\n`);
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
