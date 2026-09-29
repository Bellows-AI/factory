#!/usr/bin/env node
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
});
