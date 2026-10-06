#!/usr/bin/env node
/* Converts Claude stream-json into the safe, human-readable tail the board shows live. */
const readline = require('node:readline');

const TEXT_LIMIT = 4_096;
const ASK_TOOL = 'AskUserQuestion';
const ASKED_LINE = 'Asked a question — waiting for an answer on the task page.';

function text(value) {
    return typeof value === 'string' ? value.trim().slice(0, TEXT_LIMIT) : '';
}

function linesFor(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
    if (event.type === 'system' && event.subtype === 'init') return ['Claude session started.'];
    if (event.type !== 'assistant' || !event.message || typeof event.message !== 'object') return [];

    const content = event.message.content;
    if (!Array.isArray(content)) return [];
    const lines = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
        if (block.type === 'text') {
            const value = text(block.text);
            if (value) lines.push(value);
        } else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.trim()) {
            // Tool input can contain credentials, and a question's text is the task page's to show.
            // The tool name answers whether Claude is working.
            const name = block.name.trim();
            lines.push(name === ASK_TOOL ? ASKED_LINE : `Running ${name}.`);
        }
    }
    return lines;
}

function run(input = process.stdin, output = process.stdout) {
    const seen = new Set();
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    reader.on('line', (line) => {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        for (const progress of linesFor(event)) {
            if (seen.has(progress)) continue;
            seen.add(progress);
            output.write(`${progress}\n`);
        }
    });
}

if (require.main === module) run();

module.exports = { linesFor, run };
