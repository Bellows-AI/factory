import { describe, expect, it } from 'vitest';
import { COMMAND_LIMIT } from '../src/input.js';
import { run } from '../src/run.js';

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };
const MULTILINE = 'fix the bug\n\n  • indented, with ünïcödé and 日本語 🚀\n\ttabbed\n';

function harness(files: Record<string, string> = {}, stdin: string | Error = '') {
    const bodies: unknown[] = [];
    const err: string[] = [];
    const io = {
        env: ENV,
        fetch: (async (_url: string, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ id: 'job-2', status: 'queued' }), {
                status: 201,
                headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof globalThis.fetch,
        readFile: async (path: string) => {
            const file = files[path];
            if (file === undefined) throw new Error(`ENOENT: ${path}`);
            return file;
        },
        readStdin: async () => {
            if (stdin instanceof Error) throw stdin;
            return stdin;
        },
        stdout: () => undefined,
        stderr: (text: string) => err.push(text),
    };
    return { bodies, err, io };
}

const COMMANDS = [
    ['create', ['job', 'create']],
    ['follow-up', ['job', 'follow-up', 'job-1']],
] as const;

describe.each(COMMANDS)('factory job %s command source', (_name, base) => {
    it('sends file text byte for byte: newlines, tabs and Unicode', async () => {
        const { bodies, io } = harness({ 'p.md': MULTILINE });
        expect(await run([...base, '--file', 'p.md'], io)).toBe(0);
        expect(bodies[0]).toMatchObject({ command: MULTILINE });
    });

    it('sends stdin text byte for byte', async () => {
        const { bodies, io } = harness({}, MULTILINE);
        expect(await run([...base, '--stdin'], io)).toBe(0);
        expect(bodies[0]).toMatchObject({ command: MULTILINE });
    });

    it('accepts text exactly at the limit', async () => {
        const { bodies, io } = harness({}, 'x'.repeat(COMMAND_LIMIT));
        expect(await run([...base, '--stdin'], io)).toBe(0);
        expect(bodies).toHaveLength(1);
    });

    it.each([
        ['an empty file', ['--file', 'p.md'], { 'p.md': '' }, '', 'is empty'],
        ['a blank file', ['--file', 'p.md'], { 'p.md': ' \n\t\n' }, '', 'is empty'],
        ['empty stdin', ['--stdin'], {}, '', 'is empty'],
        ['no source at all', [], {}, '', 'is empty'],
        ['an oversized file', ['--file', 'p.md'], { 'p.md': 'x'.repeat(COMMAND_LIMIT + 1) }, '', 'exceeds'],
        ['oversized stdin', ['--stdin'], {}, 'x'.repeat(COMMAND_LIMIT + 1), 'exceeds'],
        ['an oversized positional', ['--', 'x'.repeat(COMMAND_LIMIT + 1)], {}, '', 'exceeds'],
        ['an unreadable file', ['--file', 'missing.md'], {}, '', 'cannot read --file missing.md'],
        ['positional and --file', ['--file', 'p.md', '--', 'words'], { 'p.md': 'a' }, '', 'pick one'],
        ['positional and --stdin', ['--stdin', '--', 'words'], {}, 'a', 'pick one'],
        ['--file and --stdin', ['--file', 'p.md', '--stdin'], { 'p.md': 'a' }, 'a', 'pick one'],
    ])('is a usage error for %s, with no request', async (_label, extra, files, stdin, message) => {
        const { bodies, err, io } = harness(files, stdin);
        expect(await run([...base, ...extra], io)).toBe(2);
        expect(err.join('')).toContain(message);
        expect(bodies).toHaveLength(0);
    });

    it('is a usage error when stdin cannot be read, with no request', async () => {
        const { bodies, err, io } = harness({}, new Error('EIO'));
        expect(await run([...base, '--stdin'], io)).toBe(2);
        expect(err.join('')).toContain('cannot read --stdin: EIO');
        expect(bodies).toHaveLength(0);
    });
});
