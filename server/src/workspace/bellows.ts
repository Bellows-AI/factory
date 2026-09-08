/**
 * `.bellows.yaml` — the gate declaration a repository may ship at its checkout root.
 *
 * The grammar is a deliberately tiny subset of YAML, hand-parsed: no YAML package exists in this
 * repo and none may be added for one file. Strictness is the point — a construct outside the
 * subset is a named error, never a best-effort read, because a silently dropped gate is a check
 * that never ran while everybody believed it did.
 *
 * Accepted (the issue's example is the shape):
 *
 *     environment:
 *         image: node:24
 *         gates:
 *              - name: test
 *                command: "npm test"
 *
 * Comments, blank lines, and bare / single- / double-quoted scalars are tolerated. Everything
 * else — tabs, unknown keys, a seventeenth gate, a flag-shaped image — throws with the line
 * number, and `readGatesFile` turns that into the job's `gateError`.
 */

import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';

export interface GateDef {
    readonly name: string;
    readonly command: string;
}

export interface BellowsConfig {
    readonly image: string;
    readonly gates: readonly GateDef[];
}

/** Same rules a checkout directory obeys (`badSegment`), plus a length a pill can render. */
const MAX_NAME_LENGTH = 64;
const MAX_GATES = 16;
const MAX_COMMAND_LENGTH = 4096;

/** Docker ref shape: no whitespace, no `$` expansion, nothing a CLI would read as a flag. */
const IMAGE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

class BellowsError extends Error {}

function fail(line: number, message: string): never {
    throw new BellowsError(`.bellows.yaml line ${line}: ${message}`);
}

/**
 * A scalar: bare, 'single' or "double" quoted. No escapes — a command that needs one is a script
 * in the repo, not an inline one-liner.
 */
function scalar(line: number, raw: string, what: string): string {
    const value = raw.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        if (!value.endsWith(quote) || value.length < 2) {
            fail(line, `${what}: unclosed ${quote === '"' ? 'double' : 'single'} quote`);
        }
        return value.slice(1, -1);
    }
    return value;
}

function checkImage(line: number, image: string): string {
    if (!IMAGE_PATTERN.test(image)) {
        fail(line, `image must be a plain docker reference, got "${image}"`);
    }
    return image;
}

function checkName(line: number, name: string): string {
    if (!name) fail(line, 'gate name is empty');
    if (/[/\\]/.test(name)) fail(line, `gate name "${name}" contains a path separator`);
    if (/^[-.]/.test(name)) fail(line, `gate name "${name}" starts with "-" or "."`);
    if (name.length > MAX_NAME_LENGTH) {
        fail(line, `gate name is longer than ${MAX_NAME_LENGTH} characters`);
    }
    return name;
}

/** `key: value` / `key:` — the key shape is fixed, the value may contain colons. */
const KEY_VALUE = /^([A-Za-z][A-Za-z0-9_]*):(?:(\s+)(.*))?$/;

interface RawGate {
    name?: string;
    command?: string;
}

export function parseBellows(text: string): BellowsConfig | null {
    let image: string | null = null;
    let inEnvironment = false;
    let inGates = false;
    let itemIndent = -1;
    /** Where the gate currently being read began — the line its errors name. */
    let itemLine = 0;
    let current: RawGate | null = null;
    const gates: GateDef[] = [];

    const finish = (): void => {
        if (current) {
            const line = itemLine;
            if (current.command === undefined) {
                fail(line, `gate "${current.name ?? '?'}" has no command`);
            }
            if (current.command === '') {
                fail(line, `gate "${current.name ?? '?'}" has an empty command`);
            }
            const name = checkName(line, current.name ?? '');
            if (gates.some((gate) => gate.name === name)) {
                fail(line, `gate "${name}" is declared twice`);
            }
            if (gates.length >= MAX_GATES) {
                fail(line, `more than ${MAX_GATES} gates`);
            }
            gates.push({ name, command: current.command });
            current = null;
        }
    };

    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index] ?? '';
        const line = index + 1;
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        if (rawLine.slice(0, indent).includes('\t')) {
            fail(line, 'tabs are not allowed for indentation, use spaces');
        }

        if (indent === 0) {
            finish();
            inGates = false;
            itemIndent = -1;
            const match = KEY_VALUE.exec(trimmed);
            if (!match) {
                fail(line, `expected "environment:" at the top level, got "${trimmed}"`);
            }
            if (match[1] !== 'environment') {
                fail(line, `unknown top-level key "${match[1]}" — only "environment:" is read`);
            }
            if (inEnvironment) fail(line, 'a second "environment:" block');
            if (match[3] !== undefined && match[3] !== '') {
                fail(line, 'environment takes no inline value');
            }
            inEnvironment = true;
            continue;
        }

        if (!inEnvironment) {
            fail(line, `indented content before "environment:" — "${trimmed}"`);
        }

        if (trimmed.startsWith('- ')) {
            if (!inGates) fail(line, 'a list item outside "gates:"');
            finish();
            itemIndent = indent;
            itemLine = line;
            const rest = trimmed.slice(2);
            const match = KEY_VALUE.exec(rest);
            if (!match || match[1] !== 'name' || match[3] === undefined) {
                fail(line, `a gate starts with "- name: <name>", got "${trimmed}"`);
            }
            current = { name: scalar(line, match[3], 'name') };
            continue;
        }

        const match = KEY_VALUE.exec(trimmed);
        if (!match) fail(line, `cannot read "${trimmed}"`);
        const key = match[1] ?? '';
        const hasValue = match[3] !== undefined;

        if (inGates) {
            if (itemIndent === -1 || indent <= itemIndent) {
                fail(line, `"${key}" is not indented under its "- name:" item`);
            }
            if (!current) fail(line, `"${key}" before the "- name:" that opens the gate`);
            if (key === 'name') {
                if (!hasValue) fail(line, 'name takes a value');
                current.name = scalar(line, match[3] ?? '', 'name');
            } else if (key === 'command') {
                if (!hasValue) fail(line, 'command takes a value');
                if ((match[3] ?? '').length > MAX_COMMAND_LENGTH) {
                    fail(line, `command is longer than ${MAX_COMMAND_LENGTH} characters`);
                }
                current.command = scalar(line, match[3] ?? '', 'command');
            } else {
                fail(line, `unknown gate field "${key}" — only name and command are read`);
            }
            continue;
        }

        // Direct children of `environment:`.
        if (key === 'image') {
            if (!hasValue) fail(line, 'image takes a value');
            image = checkImage(line, scalar(line, match[3] ?? '', 'image'));
        } else if (key === 'gates') {
            // `gates:` with nothing after it — including a trailing space, the same courtesy
            // `environment:` gets — opens the list. A real inline value is outside the subset.
            if (hasValue && match[3] !== '') fail(line, 'gates takes a list, not a value');
            inGates = true;
        } else {
            fail(line, `unknown key "${key}" inside environment — only image and gates are read`);
        }
    }
    finish();

    if (!inEnvironment) return null;
    if (image === null) throw new BellowsError('.bellows.yaml: environment declares no image');
    return { image, gates };
}

/**
 * What a claim needs to know about a checkout's gates, and never more.
 *
 * `config: null, error: null` is the ordinary repository — no `.bellows.yaml`, no gates, not an
 * error. A broken file is a VALUE on the claim (`gateError`), not a throw: one repository's typo
 * must fail its own jobs loudly, not take down the board's claim route.
 */
export interface GatesRead {
    readonly config: BellowsConfig | null;
    readonly error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads `<root>/<orgId>/<userId>/<repoName>/.bellows.yaml` for a claim.
 *
 * The server reads the file, not the driver: the board created these checkouts and mounts the
 * volume at `workspaceRoot`, while the driver only ever passes volume names to docker and cannot
 * open a path at all. `workspacePath` is the claim's own `<orgId>/<userId>` and the uuid segment
 * is re-asserted here before anything is joined — the `workspaceDir` posture, applied to the one
 * caller that arrives with the path as data.
 *
 * The checkout directory is the repo NAME, not the owner/name label: two owners' same-named
 * repositories share one directory per member by the `user_repo_dir_uk` decision, so the label's
 * second segment is the one that exists on disk.
 */
export async function readGatesFile(options: {
    /** Null = this deployment has no workspace root, so no checkout and no gates anywhere. */
    root: string | null;
    /** The claim's `<orgId>/<userId>`. */
    workspacePath: string;
    /** The job's `owner/name` label, or null on a job queued without one. */
    repo: string | null;
    /** Test seam: lets the suite assert the path and simulate failures without a filesystem. */
    readFile?: (path: string) => Promise<string>;
}): Promise<GatesRead> {
    const { root, workspacePath, repo, readFile = defaultRead } = options;
    if (!root || !repo) return { config: null, error: null };

    const name = repo.includes('/') ? repo.slice(repo.indexOf('/') + 1) : repo;
    // Same rules a checkout directory obeys. Unreachable from the create route (which validates
    // the whole label), asserted anyway: this module is handed strings, not trusted rows.
    if (!name || /[/\\]/.test(name) || /^[-.]/.test(name)) {
        return { config: null, error: `repo label does not name a checkout directory: ${repo}` };
    }
    const userId = workspacePath.split('/')[1] ?? '';
    if (!UUID.test(userId)) {
        return { config: null, error: `workspace path is not <orgId>/<userId>: ${workspacePath}` };
    }

    const path = join(root, workspacePath, name, GATES_FILE);
    let text: string;
    try {
        text = await readFile(path);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: null, error: null };
        return { config: null, error: (e as Error).message };
    }
    try {
        return { config: parseBellows(text), error: null };
    } catch (e) {
        return { config: null, error: (e as Error).message };
    }
}

const GATES_FILE = '.bellows.yaml';

/**
 * A ceiling generous past anything a hand-written gate file needs (the parser itself caps at 16
 * gates × 4096-char commands). Member-authored repo content read on the claim path — bounded
 * before it is read, not after, the same posture every other route-level limit takes.
 */
const GATES_FILE_LIMIT = 64 * 1024;

const defaultRead = async (path: string): Promise<string> => {
    const stats = await fsStat(path);
    if (stats.size > GATES_FILE_LIMIT) {
        throw new Error(`.bellows.yaml is larger than ${GATES_FILE_LIMIT} bytes`);
    }
    return fsReadFile(path, 'utf8') as Promise<string>;
};
