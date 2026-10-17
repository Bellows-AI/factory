#!/usr/bin/env node
'use strict';
// The runner's end of AskUserQuestion (issue #226). Plain `claude -p` has no AskUserQuestion tool;
// under `--input-format stream-json --permission-prompt-tool stdio` the CLI asks this process for
// every permission decision as a `control_request`. The bridge answers them: AskUserQuestion goes
// to the task supervisor through the mailbox (a file in FACTORY_CTL_OUT; the answer comes back as a
// file in the read-only FACTORY_CTL_IN) and the person's answer goes back into the SAME CLI
// process; every other tool is denied, which is what a headless `-p` run did before. The bridge
// holds no control credential: the supervisor relays the question to the driver.
//
// It receives the entrypoint's `"$@"`, which ends `-p <prompt>`, and passes the CLI's stdout
// through unchanged while the progress reader lives — the FIFO contract is the entrypoint's. The
// question text is never written to stderr or stdout by the bridge itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const EXIT_USAGE = 64;
const EXIT_NOT_FOUND = 127;
const SIGNAL_EXIT_BASE = 128;
const DEFAULT_POLL_MS = 1000;
const ASK_TOOL = 'AskUserQuestion';

const MSG_TOOL_DENIED = "Not pre-approved by the runner's allowlist, and nobody can approve it in this run.";
// The CLI asks about a compound command whose every part is allowlisted when it cannot match the
// whole, so a Bash denial is not a verdict on its parts.
const MSG_BASH_DENIED =
    `${MSG_TOOL_DENIED} A compound command (a \`( … )\` subshell, a heredoc, a \`;\` or \`&&\` chain) is approved ` +
    'only when every part matches the allowlist: run each part once on its own, unwrapped, before treating it as refused.';
const MSG_NOBODY = 'Nobody can answer questions in this run. Continue with your best judgment and state the assumption you made.';
const MSG_STOPPED = 'The task was stopped.';
const MSG_NO_MORE = 'This run cannot ask more questions. Continue with your best judgment and state the assumption you made.';

const inDir = process.env.FACTORY_CTL_IN;
const outDir = process.env.FACTORY_CTL_OUT;
const marker = process.env.FACTORY_STOP_MARKER;
const configuredPoll = Number(process.env.FACTORY_CTL_TICK_MS);
const pollMs = Number.isFinite(configuredPoll) && configuredPoll > 0 ? configuredPoll : DEFAULT_POLL_MS;

const deny = (message, interrupt) => ({ behavior: 'deny', message, interrupt });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopped = () => Boolean(marker) && fs.existsSync(marker);

/** The supervisor's settled answer to one question, or null while it has none. */
function readAnswer(id) {
    try {
        return JSON.parse(fs.readFileSync(path.join(inDir, 'answers', `${id}.json`), 'utf8'));
    } catch {
        // Not written yet, or caught half way: the supervisor writes it atomically, so the next poll has it whole.
        return null;
    }
}

/** The decision for one AskUserQuestion: hand it to the supervisor, then poll until a person settles it. */
async function ask(request) {
    if (!inDir || !outDir) return deny(MSG_NOBODY, false);
    const id = request.tool_use_id;
    const input = request.input ?? {};
    const questions = path.join(outDir, 'questions');
    try {
        fs.mkdirSync(questions, { recursive: true });
        const target = path.join(questions, `${id}.json`);
        fs.writeFileSync(`${target}.tmp`, JSON.stringify({ questionId: id, questions: input.questions }));
        fs.renameSync(`${target}.tmp`, target);
    } catch {
        return deny(MSG_NOBODY, false);
    }
    for (;;) {
        if (stopped()) return deny(MSG_STOPPED, true);
        const answer = readAnswer(id);
        if (answer?.state === 'answered') {
            return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
        }
        // A cancelled question is a Stop; `gone` is a supervisor whose attempt is already over.
        if (answer?.state === 'cancelled' || answer?.state === 'gone') return deny(MSG_STOPPED, true);
        if (answer?.state === 'refused' || answer?.state === 'invalid') return deny(MSG_NO_MORE, false);
        await sleep(pollMs);
    }
}

async function decide(request) {
    if (request.tool_name === 'Bash') return deny(MSG_BASH_DENIED, false);
    if (request.tool_name !== ASK_TOOL) return deny(MSG_TOOL_DENIED, false);
    return ask(request);
}

/**
 * A `--resume` of a session that left no transcript (issue #822) becomes `--session-id` under the
 * same id: a driver lost between reporting the id it minted and the CLI's first write leaves the
 * board holding a session with nothing behind it, and the CLI refuses to resume that. The lookup
 * is the turn reader's (driver/src/scripts/claude-turns.cjs); anything that cannot be read for any
 * other reason than absence (ENOENT) keeps the resume.
 */
function startUnwrittenResume(args) {
    const at = args.indexOf('--resume');
    if (at === -1 || at + 1 >= args.length) return args;
    const id = args[at + 1];
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const absent = (file) => {
        try {
            fs.statSync(file);
            return false;
        } catch (error) {
            if (error.code === 'ENOENT') return true;
            throw error;
        }
    };
    try {
        const projectDirs = absent(projects) ? [] : fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
        if (!projectDirs.every((e) => absent(path.join(projects, e.name, `${id}.jsonl`)))) return args;
    } catch {
        return args;
    }
    process.stderr.write(`claude-bridge: session ${id} left no transcript; starting it under the same id\n`);
    return [...args.slice(0, at), '--session-id', id, ...args.slice(at + 2)];
}

function main() {
    const args = process.argv.slice(2);
    if (args.at(-2) !== '-p') {
        process.stderr.write('claude-bridge: expected "-p <prompt>" as the last two arguments\n');
        process.exit(EXIT_USAGE);
    }
    const prompt = args.at(-1);
    const rest = startUnwrittenResume(args.slice(0, -2));

    // TERM and INT go to the CLI; the bridge leaves only when the CLI has. Installed BEFORE the
    // spawn: the entrypoint forwards a TERM as soon as the CLI is up, and one landing between the
    // spawn and a later listener would take Node's default action and kill the bridge, leaving
    // the CLI unsignalled. A handler runs from the event loop, never mid-main, so `cli` is set.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => cli.kill(signal));

    const cli = spawn(
        'claude',
        ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', ...rest],
        { stdio: ['pipe', 'pipe', 'inherit'] }
    );
    cli.on('error', (error) => {
        process.stderr.write(`claude-bridge: could not start claude: ${error.message}\n`);
        process.exit(EXIT_NOT_FOUND);
    });
    // The CLI can exit before a late write lands; that is the exit handler's to report, not a crash.
    cli.stdin.on('error', () => {});
    // Our stdout is the progress sidecar's FIFO (issue #798): a reader that died costs the live
    // progress, never the run — stop relaying, say so once, and let the CLI's status stand.
    let relaying = true;
    process.stdout.on('error', () => {
        if (!relaying) return;
        relaying = false;
        process.stderr.write('claude-bridge: the progress reader is gone; live progress stops, the run continues\n');
    });

    // A `result` ends a turn, and closing stdin ends the run — but the CLI still runs the turn a
    // background subagent's completion queues, and past end of input that turn's permission
    // requests fail "Stream closed". So stdin stays open while a subagent runs. A background
    // shell does not count: the CLI kills shells at end of input instead of waiting for them.
    let subagentsRunning = false;
    let inputOpen = true;
    const send = (message) => {
        if (inputOpen) cli.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const respond = (requestId, response) =>
        send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

    send({ type: 'control_request', request_id: 'factory-init', request: { subtype: 'initialize', hooks: null } });
    send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });

    const reader = readline.createInterface({ input: cli.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
        if (relaying) process.stdout.write(`${line}\n`);
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        if (!event || typeof event !== 'object') return;
        if (event.type === 'system' && event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
            subagentsRunning = event.tasks.some((task) => task?.task_type === 'local_agent');
        } else if (event.type === 'result') {
            if (subagentsRunning) return;
            inputOpen = false;
            cli.stdin.end();
        } else if (event.type === 'control_request' && event.request) {
            const requestId = event.request_id;
            if (event.request.subtype === 'can_use_tool') {
                decide(event.request).then((decision) => respond(requestId, decision));
            } else {
                send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'unsupported' } });
            }
        }
    });

    cli.on('close', (code, signal) => {
        process.exit(signal ? SIGNAL_EXIT_BASE + (os.constants.signals[signal] ?? 0) : (code ?? 0));
    });
}

main();
