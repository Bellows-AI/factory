import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Shared support for running the review scripts against a stub `gh` (split out of
 * `review-scripts.test.ts` for the line-count cap, into `review-collect-script.test.ts` and
 * `review-reply-script.test.ts`): a fake gh executable copied to a throwaway bin dir on PATH
 * that records every argv (the spawn-shape pins), refuses to answer without a credential, and
 * dishes canned payloads from the fixtures. The ambient board credentials are stripped so the
 * only token the child can ever see is the test's own.
 *
 * `afterEach` itself is NOT registered here — it must be called from each test file's own top
 * level, so the hook binds to that file's suite even when `isolate: false` shares this module's
 * cache across files in a worker.
 */
const execFile = promisify(execFileCb);

const SCRIPTS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'scripts');
export const pathOf = (name: string): string => join(SCRIPTS_DIR, name);

export const TEST_TOKEN = 'token-opencode-review-secret-42';
const EXECUTABLE_MODE = 0o755;

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', 'review');
export const fixture = (name: string): string => join(FIXTURES_DIR, name);
const FAKE_GH = readFileSync(fixture('fake-gh.cjs'), 'utf8');

export const tempDirs = new Set<string>();
export function cleanupTempDirs(): void {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.clear();
}

export interface ScriptRun {
    stdout: string;
    stderr: string;
    args: string[][];
}

/**
 * Run one review script against the stub `gh`. The pure planning functions these scripts wrap
 * (`validateReviewRef`, `buildReviewReply`, the two verdict parsers) are exercised directly,
 * offline, in `review.test.ts` — this suite pins the end-to-end spawn shape and the wire bytes a
 * real gh round trip produces.
 */
export const runScript = async (
    name: string,
    env: Record<string, string>,
    opts: { token?: boolean } = {}
): Promise<ScriptRun> => {
    const dir = mkdtempSync(join(tmpdir(), 'review-'));
    tempDirs.add(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), EXECUTABLE_MODE);
    const argvLog = join(dir, 'argv.log');
    const childEnv: Record<string, string> = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_TOKEN;
    const token = opts.token ?? true;
    Object.assign(childEnv, { GH_FIXTURES: fixture('gh-responses.json'), GH_ARGV_LOG: argvLog });
    if (token) childEnv.GITHUB_TOKEN = TEST_TOKEN;
    Object.assign(childEnv, env);
    const { stdout, stderr } = await execFile('node', [pathOf(name)], { env: childEnv });
    let args: string[][] = [];
    if (existsSync(argvLog)) {
        const raw = readFileSync(argvLog, 'utf8').trim();
        args = raw ? raw.split('\n').map((l) => JSON.parse(l) as string[]) : [];
    }
    return { stdout, stderr, args };
};

/** A disposable extra gh fixture for the boundedness runs that outgrow the canned one. */
export const writeFixture = (body: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'review-fixture-'));
    tempDirs.add(dir);
    const file = join(dir, 'responses.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
};
