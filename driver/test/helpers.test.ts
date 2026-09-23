import { describe, expect, it } from 'vitest';
import {
    HELPER_REGISTRY,
    HELPER_TIMEOUT_MS,
    helperInputValue,
    lookupHelper,
    parseHelperOutput,
    type HelperDescriptor,
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
    it('ships the noop fixture and the merge-conflict-autofix probe, with their fixed schema/version', () => {
        expect(HELPER_REGISTRY.size).toBe(2);
        const noop = lookupHelper('noop');
        expect(noop).not.toBeNull();
        expect(noop?.schema).toBe('helper-noop/v1');
        expect(noop?.version).toBe(1);

        const probe = lookupHelper('merge-conflict-probe');
        expect(probe).not.toBeNull();
        expect(probe?.schema).toBe('merge-conflict-probe/v1');
        expect(probe?.version).toBe(1);
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
