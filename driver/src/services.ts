/**
 * Auxiliary service containers (issue #6): the `.bellows.yaml` half of the feature.
 *
 * A checkout may ask the runner for sibling containers — a database, a cache — the way a CI
 * pipeline declares services. The DRIVER reads the file and spawns them, because the driver is
 * what holds the docker socket the runner deliberately does not have. This module is the pure
 * half: the parse of a file written by somebody this process does not know, and the argv arrays
 * the daemon will be given. Lifecycle (when they start, when they die) lives in docker.ts.
 *
 * Nothing here imports docker.ts, which imports this module: one direction only, so the parse
 * stays testable without a daemon and the modules cannot knot.
 */
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { containerScript } from './container-scripts.js';
import { WORKSPACE_PATH } from './publish.js';

/**
 * The readout's shell script: a real file (scripts/bellows-read.sh) read at load time and
 * passed to the container by content — never an inline template string, and never a mounted
 * path (the driver has no host path into the volumes it names). Under tsx and vitest this
 * resolves into `src/scripts/`; in the built driver into `dist/scripts/`, where the build
 * copies the directory — forgetting THAT copy fails only in the container, the
 * server/migrations trap.
 */
export const bellowsReadScript: string = containerScript('bellows-read.sh');

/** One requested service, parsed. `environment` preserves the file's order. */
export interface ServiceSpec {
    name: string;
    image: string;
    environment: { key: string; value: string }[];
}

/**
 * What a service may be called. The name becomes a container-name suffix and a network alias —
 * the hostname the author's tests resolve — so it is a DNS label: lowercase letters, digits and
 * hyphens, one to thirty characters, no hyphen at either end.
 */
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** What an environment variable name may look like before it is put on an argv. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What an image reference may look like before it goes on an argv — the one field that names what
 * the daemon executes. An allowlist, not docker's full reference grammar: it refuses whitespace,
 * `$`, `=`, quotes and a leading `-`, which is everything that could turn the image token into
 * something other than an image. A reference this refuses but the daemon would have taken costs a
 * clear author-facing refusal; the reverse trade is flag injection waiting for an append.
 */
const IMAGE = /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9._/-]+)?(?::[a-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/i;

/**
 * How many services one job may run. Enforced on the MERGE, not per file: a `.bellows.yaml` rides
 * back into this process inside a readout whose section markers are ordinary lines, so a single
 * file could otherwise forge many sections — and the checkouts are many by design. A runaway
 * fleet would otherwise start on a daemon this process holds the socket for.
 */
const MAX_SERVICES = 10;

/**
 * What the readout reads of one file before it refuses the rest. The readout's output crosses
 * execFile's default 1 MiB maxBuffer, and an oversize file would otherwise fail the read with a
 * maxBuffer error — which classifies as infrastructure and burns the job's attempts on a file
 * that cannot change. Ten services at this bound cannot reach the buffer; a real services file
 * never reaches this bound either. The readout script tripping it prints `###__bellows_error:`
 * in place of the content, which splitBellowsSections turns into the author-facing refusal.
 */
export const MAX_BELLOWS_BYTES = 65_536;

/** The line the readout container prints before each checkout's file. */
const MARKER = /^###__bellows:(.*)$/;

/**
 * Cuts a comment. A `#` opens one at line start or after whitespace, never inside quotes — which
 * is what makes `TOKEN: "ab # cd"` survive and `image: postgres # pinned` not carry its comment
 * into the tag. The tracker follows the same quoting rules scalar() decodes by, so an escape
 * cannot mis-toggle it: in a double-quoted span `\"` is a character the span holds, and in a
 * single-quoted one the doubled `''` is the whole escape, consumed as a pair.
 */
/**
 * Advances past one character of a double-quoted span. The backslash escapes the next
 * character, so `\"` is a quoted quote and the span stays open — otherwise `"va\"" # note`
 * cuts its comment inside the value.
 */
function stepDoubleQuoted(line: string, i: number): { advance: number; closed: boolean } {
    const ch = line[i];
    if (ch === '\\') return { advance: 2, closed: false };
    if (ch === '"') return { advance: 1, closed: true };
    return { advance: 1, closed: false };
}

/**
 * Advances past one character of a single-quoted span. The doubled quote is the escape: consume
 * the pair, and only a lone `'` closes the span.
 */
function stepSingleQuoted(line: string, i: number): { advance: number; closed: boolean } {
    const ch = line[i];
    if (ch === "'" && line[i + 1] === "'") return { advance: 2, closed: false };
    if (ch === "'") return { advance: 1, closed: true };
    return { advance: 1, closed: false };
}

/** Whether `line[i]` is a `#` that opens a comment: at line start, or after whitespace. */
function isCommentStart(line: string, i: number): boolean {
    if (line[i] !== '#') return false;
    return i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t';
}

/** Advances one character through the line's quote state, outside any comment. */
function advanceQuoteState(line: string, i: number, quote: string | null): { i: number; quote: string | null } {
    if (quote === '"') {
        const step = stepDoubleQuoted(line, i);
        return { i: i + step.advance, quote: step.closed ? null : quote };
    }
    if (quote === "'") {
        const step = stepSingleQuoted(line, i);
        return { i: i + step.advance, quote: step.closed ? null : quote };
    }
    const ch = line[i];
    if (ch === '"' || ch === "'") return { i: i + 1, quote: ch };
    return { i: i + 1, quote };
}

function stripComment(line: string): string {
    let quote: string | null = null;
    let i = 0;
    while (i < line.length) {
        if (quote === null && isCommentStart(line, i)) return line.slice(0, i);
        const next = advanceQuoteState(line, i, quote);
        i = next.i;
        quote = next.quote;
    }
    return line;
}

/**
 * The single-character backslash escapes a double-quoted scalar decodes (YAML 1.2 §7.3.2) — the
 * full one-character set, plus the escaped space. The variable-length hex forms (`\x` of exactly
 * two hex digits, `\u` of four, `\U` of eight) are not single characters, so they live in
 * HEX_ESCAPE_LENGTHS beside this map. Anything outside both is refused rather than passed
 * through with its backslash: the service runs on what this returns, and a forwarded escape
 * speaks for a value the author did not write.
 */
const DOUBLE_QUOTED_ESCAPES = new Map<string, string>([
    ['\\', '\\'],
    ['"', '"'],
    ['n', '\n'],
    ['t', '\t'],
    ['r', '\r'],
    ['0', '\0'],
    ['/', '/'],
    ['b', '\b'],
    ['f', '\f'],
    ['a', '\u0007'],
    ['v', '\u000B'],
    ['e', '\u001B'],
    [' ', ' '],
    ['N', '\u0085'],
    ['_', '\u00A0'],
    ['L', '\u2028'],
    ['P', '\u2029'],
]);

/**
 * The hex escapes of §7.3.2, each with the exact digit count the spec fixes for its letter.
 * Decoded with String.fromCodePoint, so the 8-digit form delivers an astral plane character as
 * the surrogate pair the container process expects. Fewer digits than the letter takes, a
 * non-hex digit where one is required, or a value past Unicode's 0x10FFFF cap (which would also
 * crash fromCodePoint as an infrastructure-looking error) is refused: all three would otherwise
 * decode a code point the author did not write.
 */
/** The digit count §7.3.2 fixes for `\u` — a 16-bit code unit. */
const HEX_ESCAPE_DIGITS_U = 4;
/** The digit count §7.3.2 fixes for `\U` — a full 32-bit code point. */
const HEX_ESCAPE_DIGITS_UPPER_U = 8;

const HEX_ESCAPE_LENGTHS = new Map<string, number>([
    ['x', 2],
    ['u', HEX_ESCAPE_DIGITS_U],
    ['U', HEX_ESCAPE_DIGITS_UPPER_U],
]);

/** Unicode's own cap — the highest code point `String.fromCodePoint` accepts. */
const UNICODE_MAX_CODE_POINT = 0x10ffff;

/**
 * A scalar. Unquoted values are kept as written (numbers included). A quoted value is decoded by
 * the rules its quoting promises — that is what makes `PASSWORD: "pa\"ss"` start the service
 * with `pa"ss` rather than the escape syntax. Single quotes (§7.3.1) know exactly one escape,
 * the doubled `''`, and a backslash is the character it is; double quotes (§7.3.2) decode the
 * full escape set above and refuse an escape outside it, under this file's standing posture that
 * a construct the parser does not understand is an error a human reads.
 */
/**
 * Decodes one backslash escape at `body[i]` (the backslash itself). Answers the decoded text and
 * how many characters, counted from the backslash, it consumed.
 */
function decodeDoubleQuotedEscape(body: string, i: number): { text: string; length: number } {
    const next = body[i + 1] ?? '';
    const hexLength = HEX_ESCAPE_LENGTHS.get(next);
    if (hexLength !== undefined) {
        // slice() returns less than asked near the end of the string, so the length check is
        // what makes "\u12" malformed rather than a silent short decode.
        const digits = body.slice(i + 2, i + 2 + hexLength);
        const point = digits.length === hexLength && /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : NaN;
        if (Number.isNaN(point) || point > UNICODE_MAX_CODE_POINT) {
            throw new Error(
                `.bellows.yaml: malformed escape "\\${next}${digits}" in a double-quoted value — ` +
                    `"\\${next}" takes exactly ${hexLength} hex digits within Unicode`
            );
        }
        return { text: String.fromCodePoint(point), length: 2 + hexLength };
    }
    const decoded = DOUBLE_QUOTED_ESCAPES.get(next);
    if (decoded === undefined) {
        throw new Error(`.bellows.yaml: unknown escape "\\${next}" in a double-quoted value`);
    }
    return { text: decoded, length: 2 };
}

function scalar(raw: string): string {
    const value = raw.trim();
    if (value.length < 2) return value;
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        const body = value.slice(1, -1);
        let out = '';
        let i = 0;
        while (i < body.length) {
            const ch = body[i];
            if (ch !== '\\') {
                out += ch;
                i += 1;
                continue;
            }
            const decoded = decodeDoubleQuotedEscape(body, i);
            out += decoded.text;
            i += decoded.length;
        }
        return out;
    }
    return value;
}

/** What an environment entry may weigh before it is refused. An `-e` travels on an argv, and
 * execve caps a single argument far below what a pasted certificate collection would weigh; a
 * bound here turns that into an author-facing refusal instead of a daemon error. */
const MAX_ENV_KEY = 256;
const MAX_ENV_VALUE = 8192;

/**
 * The line the readout prints IN PLACE OF a file it refused to read whole — an oversize one. A
 * file could forge it by containing exactly this text, which costs its own job a confusing
 * refusal and nothing else.
 */
const ERROR_PREFIX = '###__bellows_error:';

/**
 * Parses `.bellows.yaml` — the Drone services shape and nothing else:
 *
 * ```
 * services:
 *   - name: cache
 *     image: redis
 *     environment:
 *       ALLOW_EMPTY_PASSWORD: "yes"
 * ```
 *
 * Strictness is the point. The file was written by a repo author against a syntax they half-know
 * from CI; every construct this parser does not understand is refused with a message that names
 * the key, because the alternative is a pasted Drone pipeline that silently does nothing. That is
 * also where host port publishing dies: `ports:` is an unknown service key, not a supported
 * feature that failed. A file without a `services` key parses to no services — a checkout
 * carries the file only when it wants services, so nothing is an error until a service is
 * actually being defined.
 *
 * One exception, and it is not leniency: a top-level `environment:` block is the GATES half of
 * the file, read by the board's own parser (server/src/workspace/bellows.ts), and one file may
 * carry both halves. This parser skips the block wholesale — it does not judge the gates
 * grammar, and a gates-only file parses to no services — while every other unknown top-level
 * key is still refused.
 */

interface BellowsItem {
    itemIndent: number;
    name: string;
    image: string;
    environment: { key: string; value: string }[];
    inEnvironment: boolean;
    keys: Set<string>;
    envKeys: Set<string>;
}

/** Validates and files the just-finished item, when there is one. A no-op on a null item. */
function finishItem(item: BellowsItem | null, specs: ServiceSpec[]): void {
    if (!item) return;
    const { name, image, environment } = item;
    if (!name) throw new Error('.bellows.yaml: a service is missing "name"');
    if (!image) throw new Error('.bellows.yaml: a service is missing "image"');
    if (!SERVICE_NAME.test(name)) {
        throw new Error(
            `.bellows.yaml: service name "${name}" must be a lowercase DNS label ` +
                '(letters, digits and hyphens, at most 30 characters, none at either end)'
        );
    }
    if (!IMAGE.test(image)) {
        throw new Error(`.bellows.yaml: image "${image}" does not look like an image reference`);
    }
    if (specs.some((s) => s.name === name)) {
        throw new Error(`.bellows.yaml: duplicate service name "${name}"`);
    }
    specs.push({ name, image, environment });
}

/** Applies one `name:`/`image:`/`environment:` field to the item mid-parse. */
function applyServiceField(item: BellowsItem, key: string, value: string): void {
    if (key === 'name') {
        item.name = value;
        return;
    }
    if (key === 'image') {
        item.image = value;
        return;
    }
    if (key === 'environment') {
        if (value !== '') {
            throw new Error('.bellows.yaml: "environment" must be a mapping of "KEY: value" lines');
        }
        item.inEnvironment = true;
        return;
    }
    throw new Error(`.bellows.yaml: unknown service key "${key}" — supported: name, image, environment`);
}

function applyField(item: BellowsItem, chunk: string): void {
    const m = chunk.match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error(`.bellows.yaml: cannot parse line "${chunk.trim()}"`);
    // The regex guarantees both groups when it matched; `?? ''` only satisfies
    // noUncheckedIndexedAccess, and scalar('') reads as the empty value it would be.
    const key = scalar(m[1] ?? '');
    const value = scalar(m[2] ?? '');
    if (item.keys.has(key)) throw new Error(`.bellows.yaml: duplicate key "${key}" in one service`);
    item.keys.add(key);
    applyServiceField(item, key, value);
}

function refuseTopLevel(content: string): never {
    const key = scalar(content.split(':')[0] ?? content);
    if (key === 'services') {
        throw new Error('.bellows.yaml: "services" must be a list of "- name: …" items');
    }
    throw new Error(`.bellows.yaml: unknown key "${key}" — only "services" is supported`);
}

/**
 * Applies one environment-mapping line under a service's `environment:` key. Environment
 * entries sit deeper than the item's keys (`environment:` at itemIndent+2, its keys below
 * that) — the caller enforces that depth before calling this.
 */
function applyEnvironmentEntry(item: BellowsItem, content: string): void {
    const m = content.match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error(`.bellows.yaml: cannot parse line "${content}"`);
    const key = scalar(m[1] ?? '');
    const value = scalar(m[2] ?? '');
    if (!ENV_KEY.test(key)) {
        throw new Error(`.bellows.yaml: "${key}" is not a valid environment variable name`);
    }
    if (key.length > MAX_ENV_KEY || value.length > MAX_ENV_VALUE) {
        throw new Error(
            `.bellows.yaml: "${key}" is too long — keys at most ${MAX_ENV_KEY} and values at most ` +
                `${MAX_ENV_VALUE} characters`
        );
    }
    if (item.envKeys.has(key)) {
        throw new Error(`.bellows.yaml: duplicate environment key "${key}" in one service`);
    }
    item.envKeys.add(key);
    item.environment.push({ key, value });
}

/**
 * Handles one top-level line before any service item has been seen: the `services:` header, the
 * gates-half `environment:` block, or a refusal. Answers whether `services:` was just found.
 */
function applyPreamble(content: string): { seenServices: boolean; inGatesBlock: boolean } {
    const emptyList = content.match(/^services:\s*\[\s*\]$/);
    if (content === 'services:' || emptyList) return { seenServices: true, inGatesBlock: false };
    if (content.startsWith('environment:')) return { seenServices: false, inGatesBlock: true };
    refuseTopLevel(content);
}

/**
 * Advances the gates-block state for one line, and whether the main loop should skip it: every
 * line of the gates block's body is deeper than the top level, so indentation alone ends the
 * block and hands the next top-level key back to the loop.
 */
function advanceGatesBlock(inGatesBlock: boolean, indent: number): { inGatesBlock: boolean; skipLine: boolean } {
    if (!inGatesBlock) return { inGatesBlock, skipLine: false };
    if (indent > 0) return { inGatesBlock: true, skipLine: true };
    return { inGatesBlock: false, skipLine: false };
}

/** Handles a line back at indentation 0 while parsing service items — a new top-level key. */
function applyTopLevelDuringServices(content: string): boolean {
    if (content.startsWith('environment:')) return true;
    refuseTopLevel(content);
}

/** Whether this line is an environment-mapping entry under the current item's `environment:` key. */
function isEnvironmentEntryLine(item: BellowsItem, indent: number): boolean {
    return item.inEnvironment && indent > item.itemIndent + 2;
}

/** Applies one line already known to belong to the current item: an environment entry, or a top-level field. */
function applyItemLine(current: BellowsItem, indent: number, content: string): void {
    if (isEnvironmentEntryLine(current, indent)) {
        applyEnvironmentEntry(current, content);
        return;
    }
    if (indent === current.itemIndent + 2) {
        current.inEnvironment = false;
        applyField(current, content);
        return;
    }
    throw new Error(`.bellows.yaml: cannot parse line "${content}"`);
}

export function parseBellows(text: string): ServiceSpec[] {
    const specs: ServiceSpec[] = [];
    let seenServices = false;
    /** Inside a top-level `environment:` block — the gates half, not this parser's grammar. */
    let inGatesBlock = false;
    let current: BellowsItem | null = null;
    // A Windows editor's byte-order mark would otherwise make the first line `\uFEFFservices:`
    // and the refusal would print an invisible character at the user.
    const source = text.replace(/^\uFEFF/, '');

    for (const rawLine of source.split('\n')) {
        const line = stripComment(rawLine);
        if (!line.trim()) continue;
        const indent = line.length - line.trimStart().length;
        const content = line.trim();

        const gates = advanceGatesBlock(inGatesBlock, indent);
        inGatesBlock = gates.inGatesBlock;
        if (gates.skipLine) continue;

        if (!seenServices) {
            const preamble = applyPreamble(content);
            seenServices = preamble.seenServices;
            inGatesBlock = preamble.inGatesBlock;
            continue;
        }

        if (content.startsWith('- ')) {
            finishItem(current, specs);
            current = {
                itemIndent: indent,
                name: '',
                image: '',
                environment: [],
                inEnvironment: false,
                keys: new Set(),
                envKeys: new Set(),
            };
            applyField(current, content.slice(2));
            continue;
        }

        if (indent === 0) {
            inGatesBlock = applyTopLevelDuringServices(content);
            continue;
        }

        if (!current) {
            throw new Error(`.bellows.yaml: expected a "- name: …" list item under services, got "${content}"`);
        }
        applyItemLine(current, indent, content);
    }
    finishItem(current, specs);
    return specs;
}

/**
 * Splits the readout container's output into per-checkout sections. Every section's name is
 * asserted against the path-segment rule the server applies to a checkout's name (COPIED from
 * routes/helpers.ts): the marker comes out of a container's stdout, and this process reasons
 * about the name — it lands in the duplicate-service error — so it is checked here, once.
 */
export function splitBellowsSections(output: string): { repo: string; text: string }[] {
    const sections: { repo: string; text: string }[] = [];
    let current: { repo: string; lines: string[] } | null = null;
    for (const line of output.split('\n')) {
        const marker = line.match(MARKER);
        if (marker) {
            if (current) sections.push(sectionOf(current));
            // The regex guarantees the group when it matched; `?? ''` only satisfies
            // noUncheckedIndexedAccess, and the empty check below is the real guard.
            const repo = marker[1] ?? '';
            if (!repo || /[\\/]/.test(repo) || /^[-.]/.test(repo)) {
                throw new Error(
                    `.bellows.yaml: the readout named a checkout that is not a path segment: ${JSON.stringify(repo)}`
                );
            }
            current = { repo, lines: [] };
            continue;
        }
        current?.lines.push(line);
    }
    if (current) sections.push(sectionOf(current));
    return sections;

    function sectionOf(part: { repo: string; lines: string[] }): { repo: string; text: string } {
        // The readout echoes a newline after each file so a file without a trailing newline
        // cannot glue the next marker onto its last line; that padding is not content.
        while (part.lines.length && part.lines[part.lines.length - 1] === '') part.lines.pop();
        const text = part.lines.join('\n');
        // The readout's own refusal for a file it would not read whole. It arrives as the whole
        // section, in place of the file — a file could forge it only by consisting of exactly
        // this line, which costs its own job a confusing refusal and nothing else.
        if (text.startsWith(ERROR_PREFIX)) {
            throw new Error(`.bellows.yaml: ${text.slice(ERROR_PREFIX.length).trim()}`);
        }
        return { repo: part.repo, text };
    }
}

/**
 * Merges every checkout's services into one list. A name claimed by two checkouts is refused
 * with both named: they would race for one network alias, and no merge rule — first or last —
 * reads as anything but "the wrong database came up".
 */
export function collectServices(sections: { repo: string; text: string }[]): ServiceSpec[] {
    const specs: ServiceSpec[] = [];
    const repoOf = new Map<string, string>();
    for (const { repo, text } of sections) {
        for (const spec of parseBellows(text)) {
            const existing = repoOf.get(spec.name);
            if (existing !== undefined) {
                throw new Error(
                    `.bellows.yaml: service "${spec.name}" is defined in both ${existing}/ and ${repo}/ — ` +
                        'service names must be unique across a workspace'
                );
            }
            repoOf.set(spec.name, repo);
            specs.push(spec);
        }
    }
    if (specs.length > MAX_SERVICES) {
        throw new Error(`.bellows.yaml: at most ${MAX_SERVICES} services across the workspace, got ${specs.length}`);
    }
    return specs;
}

/**
 * The `docker run` argv for the throwaway container that reads the checkouts' `.bellows.yaml`
 * files. Pure, and exported, because it is the part worth pinning: it carries a board-derived
 * path as an env VALUE, never interpolated into the script text. The runner image is used
 * rather than pulling a dedicated one — every job already needs it present, and the image's own
 * entrypoint is swapped away exactly as the opencode session readout does.
 */
export function readBellowsArgs(config: DriverConfig, job: BoardJob): string[] {
    // The workspace path is asserted before anything interpolates it — it names the mount's
    // volume-subpath now, not only the script's BELLOWS_ROOT.
    const path = assertedWorkspacePath(job);
    return [
        'run',
        '--rm',
        '--mount',
        // Read-only: the script only cats. Scoped to the job's own `<orgId>/<userId>` subtree —
        // the same boundary the kubernetes readout's subPath mount enforces, and the same
        // string shape docker.ts builds for its own mounts: COPIED rather than imported, one
        // direction only (docker imports services, never the reverse). The target is the
        // subtree's own path, so BELLOWS_ROOT — the same string — resolves inside the container.
        `type=volume,src=${config.workspaceVolume},volume-subpath=${path},target=${config.workspaceMount}/${path},readonly`,
        ...Object.entries(bellowsReadEnv(config, job)).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--entrypoint',
        'sh',
        executorImage(config, job.executorType),
        '-c',
        bellowsReadScript,
    ];
}

/**
 * The claim's `<orgId>/<userId>`, asserted — or a refusal. The path becomes the readout mount's
 * `volume-subpath` and the script's `BELLOWS_ROOT`; a malformed one must name which half failed
 * before any argv or env exists.
 */
function assertedWorkspacePath(job: BoardJob): string {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) {
        throw new Error(
            `refusing to read .bellows.yaml for job ${job.id}: ` +
                `the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return job.workspacePath;
}

/**
 * The readout's environment, shared by both platforms: docker passes it as `-e NAME=value`
 * (readBellowsArgs), kubernetes as literal pod env (bellowsJobSpec). Every entry is a literal
 * path or a constant shared with the splitter below — never a credential. The workspace path is
 * re-asserted here, exactly as the script's predecessor did before it interpolated anything:
 * the value names a directory inside a shell script's glob, and the board is not something this
 * process trusts with a fragment of a command.
 */
export function bellowsReadEnv(config: DriverConfig, job: BoardJob): Record<string, string> {
    const path = assertedWorkspacePath(job);
    return {
        BELLOWS_ROOT: `${config.workspaceMount}/${path}`,
        BELLOWS_MAX_BYTES: String(MAX_BELLOWS_BYTES),
        // Passed from this constant rather than hardcoded in the script, so the marker the
        // splitter detects (sectionOf) and the marker the script prints cannot drift.
        BELLOWS_ERROR_PREFIX: ERROR_PREFIX,
    };
}

/**
 * The per-attempt user-defined network services and the runner share. Attempt-scoped by
 * contract: the lease token is minted fresh on every claim and never repeats, so this name can
 * only ever resolve to the network the attempt that computed it created — a stale attempt
 * cannot name a replacement's, which is what makes its teardown safe without any ownership
 * gate. The one job-scoped identifier is the `factory.job` label, and the only thing allowed to
 * act on it is the re-claim fence, which runs before anything is created.
 */
export function networkName(job: BoardJob): string {
    return `factory-job-${job.id}-${job.leaseToken}-services`;
}

/** The service container's name — attempt-scoped for the same reason `networkName` is. */
export function serviceContainerName(job: BoardJob, name: string): string {
    return `factory-job-${job.id}-${job.leaseToken}-svc-${name}`;
}

/**
 * The `docker run` argv for one service: detached, on the attempt's network under the service's
 * own name as alias — which is the whole feature, `redis://cache:6379` resolving inside the job —
 * and labeled by job (what the re-claim fence searches for), by lease (what makes every teardown
 * and kill resolve to this attempt's fleet and nothing else), and by service (what makes a
 * leftover nameable in a log).
 *
 * Environment values go on the argv as `-e KEY=value`, unlike the runner's own credentials which
 * travel by name: these values were already world-readable in the author's `.bellows.yaml`, and
 * no secret of this process's own ever reaches them. There is no `-p` and no `--publish`: the
 * daemon executing this argv is root on the host, and a published port is the one step from "a
 * service for my tests" to "a listener on somebody's machine".
 */
export function serviceRunArgs(job: BoardJob, spec: ServiceSpec): string[] {
    if (!SERVICE_NAME.test(spec.name)) {
        throw new Error(`refusing to run job ${job.id}: "${spec.name}" is not a safe service name`);
    }
    if (!IMAGE.test(spec.image)) {
        throw new Error(`refusing to run job ${job.id}: "${spec.image}" is not a safe image reference`);
    }
    const args = [
        'run',
        '-d',
        '--name',
        serviceContainerName(job, spec.name),
        '--label',
        `factory.job=${job.id}`,
        '--label',
        `factory.lease=${job.leaseToken}`,
        '--label',
        `factory.service=${spec.name}`,
        '--network',
        networkName(job),
        '--network-alias',
        spec.name,
    ];
    for (const { key, value } of spec.environment) {
        if (!ENV_KEY.test(key)) {
            throw new Error(`refusing to run job ${job.id}: "${key}" is not a valid environment variable name`);
        }
        args.push('-e', `${key}=${value}`);
    }
    args.push(spec.image);
    return args;
}
