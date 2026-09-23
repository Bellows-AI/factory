import { describe, expect, it } from 'vitest';
import {
    COMPOSITE_REGISTRY,
    HELPER_REGISTRY,
    HELPER_TIMEOUT_MS,
    MAX_COMPOSITE_STEPS,
    formatConcludeOutput,
    helperInputValue,
    lookupComposite,
    lookupHelper,
    parseHelperOutput,
    runComposite,
    runHelperPlan,
    validateComposite,
    type CompositeDescriptor,
    type HelperDescriptor,
    type HelperPlan,
    type HelperResult,
} from '../src/helpers.js';

/**
 * The shared, platform-agnostic half of the block-helper transport (issue #207): the registry
 * lookup, the versioned bounded-JSON parser both the docker and kubernetes runners call, and the
 * bounded input serializer. The docker/kubernetes transport SHAPES (argv, aux Job spec) are pinned
 * in docker.test.ts and k8s.test.ts; this file covers the platform-agnostic contract alone.
 */

const DESCRIPTOR: HelperDescriptor = {
    id: 'fixture',
    scriptBody: 'irrelevant to parsing',
    schema: 'fixture/v1',
    version: 1,
    outputCapBytes: 512,
};

/** A tight cap, only for the oversized-output case — the other fixtures need room for a full verdict. */
const TIGHT_DESCRIPTOR: HelperDescriptor = { ...DESCRIPTOR, outputCapBytes: 64 };

describe('the helper registry', () => {
    it('ships the noop fixture and the merge-conflict-autofix and github-review-reconcile probes, with their fixed schema/version', () => {
        expect(HELPER_REGISTRY.size).toBe(4);
        const noop = lookupHelper('noop');
        expect(noop).not.toBeNull();
        expect(noop?.schema).toBe('helper-noop/v1');
        expect(noop?.version).toBe(1);

        const probe = lookupHelper('merge-conflict-probe');
        expect(probe).not.toBeNull();
        expect(probe?.schema).toBe('merge-conflict-probe/v1');
        expect(probe?.version).toBe(1);

        const collect = lookupHelper('review-collect-probe');
        expect(collect).not.toBeNull();
        expect(collect?.schema).toBe('review-collect-probe/v1');
        expect(collect?.version).toBe(1);

        const reply = lookupHelper('review-reply-probe');
        expect(reply).not.toBeNull();
        expect(reply?.schema).toBe('review-reply-probe/v1');
        expect(reply?.version).toBe(1);
    });

    it('answers null for an id nothing registered — unknown BEFORE any container starts', () => {
        expect(lookupHelper('not-a-real-helper')).toBeNull();
        expect(lookupHelper('')).toBeNull();
    });
});

describe('parseHelperOutput', () => {
    it('parses a well-formed verdict', () => {
        const line = JSON.stringify({ schema: 'fixture/v1', version: 1, ok: true, output: { a: 1 } });
        expect(parseHelperOutput(DESCRIPTOR, line)).toEqual({ ok: true, output: { a: 1 } });
    });

    it('reads the LAST non-empty line, tolerating banner noise before it', () => {
        const line = `some banner\n${JSON.stringify({ schema: 'fixture/v1', version: 1, ok: true, output: null })}\n`;
        expect(parseHelperOutput(DESCRIPTOR, line)).toEqual({ ok: true, output: null });
    });

    it('defaults a missing output field to null, never undefined', () => {
        const line = JSON.stringify({ schema: 'fixture/v1', version: 1, ok: true });
        expect(parseHelperOutput(DESCRIPTOR, line)).toEqual({ ok: true, output: null });
    });

    // Order matters: the byte cap is checked BEFORE JSON.parse is ever attempted — an oversized
    // answer must never be handed to the parser at all.
    it('refuses output over its byte cap before attempting to parse it', () => {
        const oversized = `${'x'.repeat(TIGHT_DESCRIPTOR.outputCapBytes + 1)}`;
        const result = parseHelperOutput(TIGHT_DESCRIPTOR, oversized);
        expect(result).toEqual({
            ok: false,
            reason: 'oversized_output',
            message: expect.stringContaining(String(TIGHT_DESCRIPTOR.outputCapBytes)),
        });
    });

    it('refuses unparseable stdout as malformed_output, never a thrown context leak', () => {
        expect(parseHelperOutput(DESCRIPTOR, 'not json at all')).toEqual({
            ok: false,
            reason: 'malformed_output',
            message: expect.any(String),
        });
        expect(parseHelperOutput(DESCRIPTOR, '')).toMatchObject({ ok: false, reason: 'malformed_output' });
    });

    it('refuses a wrong schema or version as wrong_version, never agent context', () => {
        expect(
            parseHelperOutput(DESCRIPTOR, JSON.stringify({ schema: 'other/v1', version: 1, ok: true, output: null }))
        ).toMatchObject({ ok: false, reason: 'wrong_version' });
        expect(
            parseHelperOutput(DESCRIPTOR, JSON.stringify({ schema: 'fixture/v1', version: 2, ok: true, output: null }))
        ).toMatchObject({ ok: false, reason: 'wrong_version' });
    });

    it('trusts a known failure reason the script names, and folds an unknown one to runner_error', () => {
        const authFailed = JSON.stringify({
            schema: 'fixture/v1',
            version: 1,
            ok: false,
            reason: 'auth_failed',
            error: '401 from the forge',
        });
        expect(parseHelperOutput(DESCRIPTOR, authFailed)).toEqual({
            ok: false,
            reason: 'auth_failed',
            message: '401 from the forge',
        });

        const invented = JSON.stringify({
            schema: 'fixture/v1',
            version: 1,
            ok: false,
            reason: 'made-up-reason',
            error: 'boom',
        });
        expect(parseHelperOutput(DESCRIPTOR, invented)).toEqual({ ok: false, reason: 'runner_error', message: 'boom' });

        const noReason = JSON.stringify({ schema: 'fixture/v1', version: 1, ok: false });
        expect(parseHelperOutput(DESCRIPTOR, noReason)).toEqual({
            ok: false,
            reason: 'runner_error',
            message: 'the helper reported failure',
        });
    });
});

describe('helperInputValue', () => {
    it('serializes the plan input as bounded JSON, defaulting an absent input to null', () => {
        expect(helperInputValue({ helperId: 'noop', phase: 'pre', input: { a: 1 }, githubWriting: false })).toBe(
            '{"a":1}'
        );
        expect(helperInputValue({ helperId: 'noop', phase: 'pre', input: undefined, githubWriting: false })).toBe(
            'null'
        );
        expect(helperInputValue({ helperId: 'noop', phase: 'pre', input: null, githubWriting: false })).toBe('null');
    });

    it('never throws on a circular input, answering the literal string "null" instead', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(helperInputValue({ helperId: 'noop', phase: 'pre', input: circular, githubWriting: false })).toBe(
            'null'
        );
    });
});

describe('HELPER_TIMEOUT_MS', () => {
    it('is a positive, whole-second-aligned bound both transports can share', () => {
        expect(HELPER_TIMEOUT_MS).toBeGreaterThan(0);
        expect(HELPER_TIMEOUT_MS % 1000).toBe(0);
    });
});

/**
 * Issue #230: a successful pre-helper's explicit continue/conclude control, and the allowlisted
 * composite/helper-program descriptor that sequences registered script helpers with pure planning
 * between them.
 */
describe('parseHelperOutput: control (issue #230)', () => {
    it('omits control entirely when the wire verdict never mentions it — the exact pre-#230 shape', () => {
        const line = JSON.stringify({ schema: 'fixture/v1', version: 1, ok: true, output: null });
        expect(parseHelperOutput(DESCRIPTOR, line)).toEqual({ ok: true, output: null });
    });

    it('attaches an explicit "continue" or "conclude" control verbatim', () => {
        const continuing = JSON.stringify({
            schema: 'fixture/v1',
            version: 1,
            ok: true,
            output: null,
            control: 'continue',
        });
        expect(parseHelperOutput(DESCRIPTOR, continuing)).toEqual({ ok: true, output: null, control: 'continue' });

        const concluding = JSON.stringify({
            schema: 'fixture/v1',
            version: 1,
            ok: true,
            output: { done: true },
            control: 'conclude',
        });
        expect(parseHelperOutput(DESCRIPTOR, concluding)).toEqual({
            ok: true,
            output: { done: true },
            control: 'conclude',
        });
    });

    it('fails closed as invalid_control on an unrecognized control value, before any success is returned', () => {
        const line = JSON.stringify({ schema: 'fixture/v1', version: 1, ok: true, output: null, control: 'abort' });
        expect(parseHelperOutput(DESCRIPTOR, line)).toEqual({
            ok: false,
            reason: 'invalid_control',
            message: expect.stringContaining('abort'),
        });
    });
});

describe('formatConcludeOutput', () => {
    it('passes a string through verbatim, so a helper marker still lands on the exact final line', () => {
        expect(formatConcludeOutput('VERDICT: UP-TO-DATE')).toBe('VERDICT: UP-TO-DATE');
    });

    it('JSON-stringifies anything else, defaulting an absent/undefined output to null', () => {
        expect(formatConcludeOutput({ a: 1 })).toBe('{"a":1}');
        expect(formatConcludeOutput(null)).toBe('null');
        expect(formatConcludeOutput(undefined)).toBe('null');
    });

    it('never throws on a circular object, answering the literal string "null" instead', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(formatConcludeOutput(circular)).toBe('null');
    });
});

describe('the composite registry (issue #230)', () => {
    it('ships exactly the neutral sequence-fixture composite, over two noop steps', () => {
        expect(COMPOSITE_REGISTRY.size).toBe(1);
        const fixture = lookupComposite('sequence-fixture');
        expect(fixture).not.toBeNull();
        expect(fixture?.steps).toEqual([
            { helperId: 'noop', githubWriting: false },
            { helperId: 'noop', githubWriting: false },
        ]);
    });

    it('answers null for an id nothing registered as a composite', () => {
        expect(lookupComposite('not-a-real-composite')).toBeNull();
        expect(lookupComposite('noop')).toBeNull(); // a script id, never a composite
    });

    const fn = () => null;

    it('validates a well-formed composite against real registered script ids', () => {
        const good: CompositeDescriptor = {
            id: 'ok-composite',
            steps: [{ helperId: 'noop', githubWriting: false }],
            planStepInput: fn,
            finalize: () => ({ output: null, control: 'continue' }),
        };
        expect(() => validateComposite(good, new Set(['noop']), new Set())).not.toThrow();
    });

    it('refuses a composite id that collides with a registered script helper id', () => {
        const collides: CompositeDescriptor = {
            id: 'noop',
            steps: [{ helperId: 'noop', githubWriting: false }],
            planStepInput: fn,
            finalize: () => ({ output: null, control: 'continue' }),
        };
        expect(() => validateComposite(collides, new Set(['noop']), new Set())).toThrow(/collides/);
    });

    it('refuses an empty step list, and one over MAX_COMPOSITE_STEPS', () => {
        const empty: CompositeDescriptor = {
            id: 'empty',
            steps: [],
            planStepInput: fn,
            finalize: () => ({ output: null, control: 'continue' }),
        };
        expect(() => validateComposite(empty, new Set(['noop']), new Set())).toThrow(/1\.\.8/);

        const tooMany: CompositeDescriptor = {
            id: 'too-many',
            steps: Array.from({ length: MAX_COMPOSITE_STEPS + 1 }, () => ({ helperId: 'noop', githubWriting: false })),
            planStepInput: fn,
            finalize: () => ({ output: null, control: 'continue' }),
        };
        expect(() => validateComposite(tooMany, new Set(['noop']), new Set())).toThrow(/1\.\.8/);
    });

    it('refuses a step naming an unregistered helper id', () => {
        const unregistered: CompositeDescriptor = {
            id: 'bad-step',
            steps: [{ helperId: 'not-a-real-helper', githubWriting: false }],
            planStepInput: fn,
            finalize: () => ({ output: null, control: 'continue' }),
        };
        expect(() => validateComposite(unregistered, new Set(['noop']), new Set())).toThrow(/unregistered/);
    });

    it('refuses a step naming another composite id — no nesting', () => {
        const nested: CompositeDescriptor = {
            id: 'nests',
            steps: [{ helperId: 'inner-composite', githubWriting: false }],
            planStepInput: fn,
            finalize: () => ({ output: null, control: 'continue' }),
        };
        expect(() => validateComposite(nested, new Set(['noop']), new Set(['inner-composite']))).toThrow(/nesting/);
    });

    it('refuses a descriptor whose planStepInput or finalize is not a function', () => {
        const badPlanner = {
            id: 'bad-planner',
            steps: [{ helperId: 'noop', githubWriting: false }],
            planStepInput: 'not a function',
            finalize: () => ({ output: null, control: 'continue' }),
        } as unknown as CompositeDescriptor;
        expect(() => validateComposite(badPlanner, new Set(['noop']), new Set())).toThrow(/planStepInput/);
    });
});

describe('runHelperPlan (issue #230)', () => {
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: null,
        githubWriting: false,
        ...over,
    });
    const fn = () => null;

    it('delegates a plain (non-composite) plan straight to invokeChild, unchanged', async () => {
        const calls: HelperPlan[] = [];
        const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => {
            calls.push(childPlan);
            return { ok: true, output: { echoed: childPlan.input } };
        };
        const result = await runHelperPlan(plan({ input: { a: 1 } }), invokeChild);
        expect(calls).toEqual([plan({ input: { a: 1 } })]);
        expect(result).toEqual({ ok: true, output: { echoed: { a: 1 } } });
    });

    it('propagates invokeChild answering null (stand down / abandon) immediately', async () => {
        const result = await runHelperPlan(plan(), async () => null);
        expect(result).toBeNull();
    });

    it('sequences a composite over its declared child steps, transforming output between them', async () => {
        const calls: HelperPlan[] = [];
        const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => {
            calls.push(childPlan);
            return { ok: true, output: { sawInput: childPlan.input } };
        };
        const result = await runHelperPlan(plan({ helperId: 'sequence-fixture', input: { seed: 'x' } }), invokeChild);

        expect(calls).toHaveLength(2);
        expect(calls[0]!.helperId).toBe('noop');
        expect(calls[0]!.input).toEqual({ step: 0, seed: { seed: 'x' } });
        expect(calls[1]!.helperId).toBe('noop');
        expect(calls[1]!.input).toEqual({
            step: 1,
            receivedFromStep0: { sawInput: { step: 0, seed: { seed: 'x' } } },
        });
        expect(result).toMatchObject({ ok: true, control: 'continue' });
    });

    it('decides conclude vs. continue from the composite input, via its own finalize', async () => {
        const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => ({
            ok: true,
            output: childPlan.input,
        });

        const concluding = await runHelperPlan(
            plan({ helperId: 'sequence-fixture', input: { conclude: true } }),
            invokeChild
        );
        expect(concluding).toMatchObject({ ok: true, control: 'conclude' });

        const continuing = await runHelperPlan(
            plan({ helperId: 'sequence-fixture', input: { conclude: false } }),
            invokeChild
        );
        expect(continuing).toMatchObject({ ok: true, control: 'continue' });
    });

    it('propagates the FIRST failing child result unchanged, and never runs later steps', async () => {
        const calls: HelperPlan[] = [];
        const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => {
            calls.push(childPlan);
            return { ok: false, reason: 'timeout', message: 'the child ran out of time' };
        };
        const result = await runHelperPlan(plan({ helperId: 'sequence-fixture' }), invokeChild);

        expect(calls).toHaveLength(1);
        expect(result).toEqual({ ok: false, reason: 'timeout', message: 'the child ran out of time' });
    });

    it('fails closed as invalid_composite_plan when the top-level plan itself declares githubWriting', async () => {
        const result = await runHelperPlan(plan({ helperId: 'sequence-fixture', githubWriting: true }), async () => {
            throw new Error('no child must ever be invoked');
        });
        expect(result).toEqual({ ok: false, reason: 'invalid_composite_plan', message: expect.any(String) });
    });

    it('fails closed as invalid_composite_plan when planStepInput throws, before the child it was planning for ever runs', async () => {
        const throwingComposite: CompositeDescriptor = {
            id: 'throwing-planner',
            steps: [
                { helperId: 'noop', githubWriting: false },
                { helperId: 'noop', githubWriting: false },
            ],
            planStepInput: () => {
                throw new Error('boom');
            },
            finalize: () => ({ output: null, control: 'continue' }),
        };
        const calls: HelperPlan[] = [];
        const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => {
            calls.push(childPlan);
            return { ok: true, output: null };
        };

        const result = await runComposite(throwingComposite, plan({ helperId: 'throwing-planner' }), invokeChild);

        expect(calls).toEqual([]);
        expect(result).toEqual({
            ok: false,
            reason: 'invalid_composite_plan',
            message: expect.stringContaining('boom'),
        });
    });

    it('fails closed as invalid_composite_plan when finalize throws, after every child already succeeded', async () => {
        const throwingFinalizer: CompositeDescriptor = {
            id: 'throwing-finalizer',
            steps: [{ helperId: 'noop', githubWriting: false }],
            planStepInput: fn,
            finalize: () => {
                throw new Error('kaboom');
            },
        };
        const invokeChild = async (): Promise<HelperResult | null> => ({ ok: true, output: null });

        const result = await runComposite(throwingFinalizer, plan({ helperId: 'throwing-finalizer' }), invokeChild);

        expect(result).toEqual({
            ok: false,
            reason: 'invalid_composite_plan',
            message: expect.stringContaining('kaboom'),
        });
    });
});
