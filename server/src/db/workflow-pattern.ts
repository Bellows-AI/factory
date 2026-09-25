/**
 * The parameter pattern grammar: a STRICT SUBSET of regular expressions, refused on any doubt.
 * A pattern runs in the board's event loop (the route validates every launch value) and in every
 * member's browser (the composer mirrors the check per keystroke), so an ambiguous pattern must
 * never be stored — catastrophic backtracking on a ≤512-character value would hang the whole
 * board process, not just the request. The subset bounds the work by construction:
 *
 * - literals, `.`, the class shorthands (`\d \D \w \W \s \S \b \B`) and punctuation escapes only
 *   — no backreferences, no `\u`/`\p`/`\c`/`\k`, no anchors (`^`/`$` are implicit in the full
 *   match), no lookarounds;
 * - quantifiers (`* + ? {m} {m,} {m,n}`) apply to a single atom only — never to a group, never
 *   to another quantifier;
 * - the AMBIGUITY BUDGET: quantified atoms chain into a "run" only when nothing mandatory sits
 *   between them (groups are transparent to this — `(a+)(a+)` is a run of two, the classic
 *   blowup shape); a run is capped at MAX_QUANTIFIED_RUN, the whole pattern at
 *   MAX_QUANTIFIED_ATOMS, and bounded repetitions at MAX_PATTERN_BOUND. Alternation carries its
 *   own budget, MAX_ALTERNATIONS branch boundaries: `(a|aa)(a|aa)…` composes 2ⁿ match paths with
 *   no quantifier anywhere, so unbounded alternation would stack 2ⁿ on top of the quantifier
 *   budget — capping the boundaries keeps the worst backtrack a small constant times
 *   C(value-length, MAX_QUANTIFIED_RUN) instead of exponential in the pattern.
 *
 * Everything else is refused at create (`BAD_PARAMS`) — the same loud-refusal doctrine as the
 * rest of the grammar. Split out of workflow-schema.ts purely to keep each parser under the
 * repo's complexity/line ceilings; still pure, still no I/O.
 */
const MAX_QUANTIFIED_ATOMS = 4;
const MAX_QUANTIFIED_RUN = 3;
const MAX_PATTERN_BOUND = 64;
const MAX_ALTERNATIONS = 2;
const CLASS_SHORTHANDS = 'dDwWsSbB';
/** A non-capturing group prefix — the only group form the subset allows. */
const NON_CAPTURING_PREFIX = '(?:';

/** Parser state shared across a whole pattern, including every nested group. */
interface PatternParseState {
    source: string;
    pos: number;
    quantifiedTotal: number;
    /** Branch boundaries compose alternatives exactly like quantifiers do — `(a|aa)(a|aa)…` is
     * the blowup shape with no quantifier anywhere — so they carry their own budget. */
    alternations: number;
    /** The ambiguity budget: quantified atoms currently chained with nothing mandatory between
     * them. Shared across a sequence and its groups on purpose — `(a+)(a+)` chains THROUGH the
     * group boundary, which is exactly the shape the cap exists for. */
    run: number;
}

/** State local to one sequence's walk — a fresh instance per group, since a group recurses. */
interface SequenceLocal {
    prev: 'none' | 'atom' | 'quantified' | 'group' | 'bar';
    /** What `run` becomes if the pending atom ends up quantified: a chain continues through it
     * only when it sits directly after a quantified atom (nothing mandatory between). */
    chainIfQuantified: number;
}

/** The outcome of one character's dispatch: either the sequence is finished (`ok` is the verdict), or it continues. */
type SeqStep = { done: true; ok: boolean } | { done: false };

const CONTINUE: SeqStep = { done: false };

function isValidClassEscape(next: string | undefined): boolean {
    return next !== undefined && /[dDwWsS]/.test(next);
}

/** Parses `[...]` from `state.pos` (at '[') past the closing ']'. */
function parsePatternClass(state: PatternParseState): boolean {
    state.pos += 1; // past '['
    if (state.source[state.pos] === '^') state.pos += 1;
    let items = 0;
    while (state.pos < state.source.length && state.source[state.pos] !== ']') {
        if (state.source[state.pos] === '\\') {
            if (!isValidClassEscape(state.source[state.pos + 1])) return false;
            state.pos += 2;
        } else {
            state.pos += 1;
        }
        items += 1;
    }
    if (state.source[state.pos] !== ']' || items === 0) return false;
    state.pos += 1;
    return true;
}

function handleGroupClose(state: PatternParseState, local: SequenceLocal, stop: 'eof' | 'group'): SeqStep {
    if (stop !== 'group') return { done: true, ok: false };
    if (local.prev === 'atom') state.run = 0; // the trailing atom resolved unquantified
    state.pos += 1;
    return { done: true, ok: true };
}

function handleAlternation(state: PatternParseState, local: SequenceLocal): SeqStep {
    state.alternations += 1;
    if (state.alternations > MAX_ALTERNATIONS) return { done: true, ok: false };
    state.run = 0; // a branch boundary breaks any chain
    local.prev = 'bar';
    state.pos += 1;
    return CONTINUE;
}

function handleUnboundedQuantifier(state: PatternParseState, local: SequenceLocal): SeqStep {
    if (local.prev !== 'atom') return { done: true, ok: false };
    state.run = local.chainIfQuantified;
    state.quantifiedTotal += 1;
    if (state.quantifiedTotal > MAX_QUANTIFIED_ATOMS || state.run > MAX_QUANTIFIED_RUN)
        return { done: true, ok: false };
    local.prev = 'quantified';
    state.pos += 1;
    return CONTINUE;
}

function handleBoundedQuantifier(state: PatternParseState, local: SequenceLocal): SeqStep {
    const bounded = /^\{(\d+)(,(\d+)?)?\}/.exec(state.source.slice(state.pos));
    if (bounded === null) return { done: true, ok: false }; // a literal brace must be escaped
    if (bounded[2] !== undefined && bounded[3] === undefined) return { done: true, ok: false }; // open-ended {m,}: write {m,64} or +
    const min = Number(bounded[1]!);
    const max = bounded[3] === undefined ? min : Number(bounded[3]);
    if (min > max || max > MAX_PATTERN_BOUND) return { done: true, ok: false };
    if (local.prev !== 'atom') return { done: true, ok: false };
    state.run = local.chainIfQuantified;
    state.quantifiedTotal += 1;
    if (state.quantifiedTotal > MAX_QUANTIFIED_ATOMS || state.run > MAX_QUANTIFIED_RUN)
        return { done: true, ok: false };
    local.prev = 'quantified';
    state.pos += bounded[0].length;
    return CONTINUE;
}

function handleGroupOpen(state: PatternParseState, local: SequenceLocal): SeqStep {
    if (local.prev === 'atom') state.run = 0; // the pending atom resolved unquantified
    const isNonCapturing = state.source.startsWith(NON_CAPTURING_PREFIX, state.pos);
    if (state.source.startsWith('(?', state.pos) && !isNonCapturing) {
        return { done: true, ok: false }; // lookarounds and named groups
    }
    state.pos += isNonCapturing ? NON_CAPTURING_PREFIX.length : 1;
    if (!parsePatternSequence(state, 'group')) return { done: true, ok: false };
    // parsePatternSequence consumed through the ')' and left the group's trailing run
    local.prev = 'group';
    return CONTINUE;
}

function handleCharClass(state: PatternParseState, local: SequenceLocal): SeqStep {
    if (local.prev === 'atom') state.run = 0; // the pending atom resolved unquantified
    if (!parsePatternClass(state)) return { done: true, ok: false };
    local.chainIfQuantified = state.run + 1;
    local.prev = 'atom';
    return CONTINUE;
}

function handleEscape(state: PatternParseState, local: SequenceLocal): SeqStep {
    const next = state.source[state.pos + 1];
    if (next === undefined) return { done: true, ok: false };
    // Class shorthands are atoms; every other alphanumeric escape — backreferences, \u, \p, \c,
    // \k — is outside the subset. Punctuation escapes are literals.
    if (/[a-zA-Z0-9]/.test(next) && !CLASS_SHORTHANDS.includes(next)) return { done: true, ok: false };
    state.pos += 2;
    if (local.prev === 'atom') state.run = 0;
    local.chainIfQuantified = state.run + 1;
    local.prev = 'atom';
    return CONTINUE;
}

function handleLiteralChar(state: PatternParseState, local: SequenceLocal): SeqStep {
    state.pos += 1;
    if (local.prev === 'atom') state.run = 0;
    local.chainIfQuantified = state.run + 1;
    local.prev = 'atom';
    return CONTINUE;
}

/** Dispatches one character of a sequence to its handler — the whole grammar in one place. */
function dispatchPatternChar(
    ch: string,
    state: PatternParseState,
    local: SequenceLocal,
    stop: 'eof' | 'group'
): SeqStep {
    if (ch === ')') return handleGroupClose(state, local, stop);
    if (ch === '|') return handleAlternation(state, local);
    if (ch === '*' || ch === '+' || ch === '?') return handleUnboundedQuantifier(state, local);
    if (ch === '{') return handleBoundedQuantifier(state, local);
    if (ch === '(') return handleGroupOpen(state, local);
    if (ch === '[') return handleCharClass(state, local);
    if (ch === '\\') return handleEscape(state, local);
    if (ch === '^' || ch === '$' || ch === ']' || ch === '}') return { done: true, ok: false };
    return handleLiteralChar(state, local);
}

/**
 * Parses a sequence until end-of-source (`eof`) or the closing `)` of its group (`group`). `local`
 * is fresh per invocation — quantifier legality only ever looks at the immediately preceding token
 * — while `state` is shared, because ambiguity composes across group boundaries but not across a
 * mandatory atom, which resets the run.
 */
function parsePatternSequence(state: PatternParseState, stop: 'eof' | 'group'): boolean {
    const local: SequenceLocal = { prev: 'none', chainIfQuantified: state.run + 1 };
    while (state.pos < state.source.length) {
        const ch = state.source[state.pos]!;
        const step = dispatchPatternChar(ch, state, local, stop);
        if (step.done) return step.ok;
    }
    return stop === 'eof';
}

export function isSafePattern(source: string): boolean {
    const state: PatternParseState = { source, pos: 0, quantifiedTotal: 0, alternations: 0, run: 0 };
    return parsePatternSequence(state, 'eof');
}
