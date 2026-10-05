#!/usr/bin/env node
'use strict';
// Claude Code's step boundary for a cooperative Stop (issue #442): the baked PostToolUse hook.
// After every tool call it checks the stop marker the stop poller writes; when it exists it
// answers `{"continue": false}`, which ends the headless run before the model is asked for
// another step. Reads only the marker — never the control credential. Fails open: any error
// leaves the run going, and the driver's grace kill is the backstop.
const fs = require('node:fs');

const DEFAULT_MARKER = '/tmp/factory-stop';
const marker = process.env.FACTORY_STOP_MARKER || DEFAULT_MARKER;

if (fs.existsSync(marker)) {
    process.stdout.write(
        `${JSON.stringify({ continue: false, stopReason: 'Factory: the task was stopped; finishing at this step boundary.' })}\n`
    );
}
