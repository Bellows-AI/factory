#!/usr/bin/env node
import { run } from './run.js';

// A local interrupt aborts the in-flight request; the command then ends `interrupted`, which is
// not a remote cancellation — the task on the board is untouched.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());
process.once('SIGTERM', () => interrupt.abort());

process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    signal: interrupt.signal,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
});
