import { fail, KEY_VALUE, MAX_COMMAND_LENGTH, scalar } from './bellows-grammar.js';

/**
 * The `reviewers:` block of `.bellows.yaml` (issue #549): named reviewer profiles an agent may
 * invoke as a separate run.
 *
 *     reviewers:
 *         - name: security
 *           instructions: "Look for injection and leaked secrets."
 *           timeout: 10
 *           connections: JIRA_TOKEN, SONAR_TOKEN
 *
 * `instructions` is the one required field; `timeout` is whole minutes (a budget the driver caps by
 * its own ceiling); `connections` lists the env names the reviewer may receive — nothing else of the
 * member's env reaches it. `readGatesFile` reads this from the base clone only, like `policy:`.
 */

/** One named reviewer profile: its own instructions, the env it may receive, and its wall-clock budget. */
export interface ReviewerProfile {
    readonly name: string;
    readonly instructions: string;
    readonly timeoutMinutes: number;
    readonly connections: readonly string[];
}

export const REVIEWER_DEFAULT_TIMEOUT_MINUTES = 15;
const REVIEWER_MAX_TIMEOUT_MINUTES = 120;
const MAX_REVIEWERS = 8;
const MAX_CONNECTIONS = 8;
/** A reviewer profile's name; the review route validates a request's `profile` against the same shape. */
export const REVIEWER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONNECTION_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

interface RawReviewer {
    name: string;
    instructions?: string;
    timeoutMinutes?: number;
    connections?: string[];
}

/** Where a parse is within the block: inside it, whether one was seen, and the item being read. */
export interface ReviewersBlock {
    open: boolean;
    seen: boolean;
    itemIndent: number;
    /** Where the reviewer currently being read began — the line its errors name. */
    itemLine: number;
    current: RawReviewer | null;
    profiles: ReviewerProfile[];
}

export const newReviewersBlock = (): ReviewersBlock => ({
    open: false,
    seen: false,
    itemIndent: -1,
    itemLine: 0,
    current: null,
    profiles: [],
});

/** The `reviewers:` header: one block per file, no inline value. */
export function openReviewersBlock(block: ReviewersBlock, line: number, inlineValue: string | undefined): void {
    if (block.seen) fail(line, 'a second "reviewers:" block');
    if (inlineValue !== undefined && inlineValue !== '') fail(line, 'reviewers takes a list, not a value');
    block.seen = true;
    block.open = true;
}

/** Closes the reviewer item being read: the instructions are the one required field. */
export function finishReviewer(block: ReviewersBlock): void {
    const current = block.current;
    if (!current) return;
    const line = block.itemLine;
    if (current.instructions === undefined || current.instructions.trim() === '') {
        fail(line, `reviewer "${current.name}" has no instructions`);
    }
    if (block.profiles.some((profile) => profile.name === current.name)) {
        fail(line, `reviewer "${current.name}" is declared twice`);
    }
    if (block.profiles.length >= MAX_REVIEWERS) fail(line, `more than ${MAX_REVIEWERS} reviewers`);
    block.profiles.push({
        name: current.name,
        instructions: current.instructions,
        timeoutMinutes: current.timeoutMinutes ?? REVIEWER_DEFAULT_TIMEOUT_MINUTES,
        connections: current.connections ?? [],
    });
    block.current = null;
}

/** `connections: A, B` — env names the reviewer may receive, each upper-case, a handful at most. */
function readConnections(line: number, raw: string): string[] {
    const names = scalar(line, raw, 'connections')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
    if (names.length > MAX_CONNECTIONS) fail(line, `more than ${MAX_CONNECTIONS} connections`);
    for (const name of names) {
        if (!CONNECTION_NAME.test(name)) fail(line, `connection "${name}" is not an env name like JIRA_TOKEN`);
    }
    return names;
}

function readTimeout(line: number, raw: string): number {
    const minutes = Number(scalar(line, raw, 'timeout'));
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > REVIEWER_MAX_TIMEOUT_MINUTES) {
        fail(line, `timeout is whole minutes, 1 to ${REVIEWER_MAX_TIMEOUT_MINUTES}`);
    }
    return minutes;
}

/** A `- name: <name>` line opening one reviewer item. */
function startReviewer(block: ReviewersBlock, line: number, indent: number, trimmed: string): void {
    finishReviewer(block);
    block.itemIndent = indent;
    block.itemLine = line;
    const match = KEY_VALUE.exec(trimmed.slice(2));
    if (!match || match[1] !== 'name' || match[3] === undefined) {
        fail(line, `a reviewer starts with "- name: <name>", got "${trimmed}"`);
    }
    const name = scalar(line, match[3], 'name');
    if (!REVIEWER_NAME.test(name)) fail(line, `reviewer name "${name}" must be lowercase letters, digits and hyphens`);
    block.current = { name };
}

/** One field of the open reviewer item. */
function readField(current: RawReviewer, line: number, key: string, raw: string): void {
    if (key === 'instructions') {
        if (current.instructions !== undefined) fail(line, 'instructions is declared twice');
        if (raw.length > MAX_COMMAND_LENGTH) fail(line, `instructions is longer than ${MAX_COMMAND_LENGTH} characters`);
        current.instructions = scalar(line, raw, 'instructions');
    } else if (key === 'timeout') {
        current.timeoutMinutes = readTimeout(line, raw);
    } else if (key === 'connections') {
        current.connections = readConnections(line, raw);
    } else {
        fail(line, `unknown reviewer key "${key}" — only name, instructions, timeout and connections are read`);
    }
}

/**
 * One line of the file as seen by an open `reviewers:` block: true when the block took it, false
 * when the block is not open or this line is back at the top level and closed it — the caller then
 * dispatches the line itself.
 */
export function consumeReviewerLine(block: ReviewersBlock, line: number, indent: number, trimmed: string): boolean {
    if (!block.open) return false;
    if (indent > 0) {
        handleReviewerLine(block, line, indent, trimmed);
        return true;
    }
    finishReviewer(block);
    block.open = false;
    return false;
}

/** One line inside `reviewers:` — a `- name:` item start, or a field of the open item. */
function handleReviewerLine(block: ReviewersBlock, line: number, indent: number, trimmed: string): void {
    if (trimmed.startsWith('- ')) {
        startReviewer(block, line, indent, trimmed);
        return;
    }
    const match = KEY_VALUE.exec(trimmed);
    if (!match) fail(line, `cannot read "${trimmed}"`);
    const key = match[1] ?? '';
    if (!block.current || indent <= block.itemIndent) fail(line, `"${key}" is not indented under its "- name:" item`);
    readField(block.current, line, key, match[3] ?? '');
}
