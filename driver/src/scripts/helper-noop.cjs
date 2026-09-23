'use strict';

/*
 * The one shipped block-helper fixture (issue #207): echoes its bounded HELPER_INPUT back as its
 * output, under the versioned verdict every helper answers with. It exists to prove the transport
 * — argv/env secrecy, the output cap, cleanup, failure semantics — end to end on both executors
 * with no real board-owned side effect; a real helper (#122/#133's own files) answers the same
 * shape, read from `driver/src/helpers.ts`'s registry the same way.
 *
 * Environment:
 *   HELPER_INPUT  the plan's bounded JSON input, as a literal value (never a credential) — absent
 *                 or unparseable reads as null, never a crash.
 */

let input = null;
try {
    input = process.env.HELPER_INPUT ? JSON.parse(process.env.HELPER_INPUT) : null;
} catch {
    input = null;
}

process.stdout.write(`${JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: input })}\n`);
