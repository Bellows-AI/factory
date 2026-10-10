import { readFile } from 'node:fs/promises';

/**
 * The one resolver for a command's text — create, follow-up and the edit command all go through
 * it. Exactly one source is chosen: positional words, `--file <path>`, or `--stdin`. Every refusal
 * is a `InputError` raised before any HTTP call. File and stdin text is sent exactly as read
 * (newlines and Unicode intact); only positional words are joined and trimmed, as a shell would.
 */

/** The board's own bound on a command (`core/src/limits.ts`), mirrored so an oversized prompt never round-trips. */
export const COMMAND_LIMIT = 16_384;

/** The options a command that takes text declares, spread into its `parseArgs`. */
export const INPUT_OPTIONS = {
    file: { type: 'string' },
    stdin: { type: 'boolean' },
} as const;

/** The input problem: the command line or its source, not the board, is what refused. */
export class InputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InputError';
    }
}

export interface InputIo {
    /** Reads a whole file as UTF-8 — injected so tests touch no disk. */
    readFile?: ((path: string) => Promise<string>) | undefined;
    /** Reads stdin to its end as UTF-8. */
    readStdin?: (() => Promise<string>) | undefined;
}

export interface InputSelection {
    positionals: readonly string[];
    file?: string | undefined;
    stdin?: boolean | undefined;
}

const readUtf8 = (path: string) => readFile(path, 'utf8');

export async function readAllStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString('utf8');
}

function bounded(text: string, source: string): string {
    if (!text.trim()) throw new InputError(`the command from ${source} is empty`);
    if (text.length > COMMAND_LIMIT) {
        throw new InputError(`the command from ${source} exceeds ${COMMAND_LIMIT} characters (${text.length})`);
    }
    return text;
}

async function readSource(source: string, read: () => Promise<string>): Promise<string> {
    try {
        return await read();
    } catch (error) {
        throw new InputError(`cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function resolveInput(selection: InputSelection, io: InputIo): Promise<string> {
    const words = selection.positionals.join(' ').trim();
    const chosen = [words ? 'positional words' : null, selection.file !== undefined ? '--file' : null, selection.stdin ? '--stdin' : null].filter(
        (name) => name !== null
    );
    if (chosen.length > 1) throw new InputError(`pick one command source, got ${chosen.join(' and ')}`);

    if (selection.file !== undefined) {
        const path = selection.file;
        const text = await readSource(`--file ${path}`, () => (io.readFile ?? readUtf8)(path));
        return bounded(text, `--file ${path}`);
    }
    if (selection.stdin) {
        if (!io.readStdin) throw new InputError('cannot read --stdin: no standard input is attached');
        return bounded(await readSource('--stdin', io.readStdin), '--stdin');
    }
    return bounded(words, 'the command line');
}
