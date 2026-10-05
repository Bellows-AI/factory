// A scripted, Anthropic-compatible model endpoint for the real agent CLIs (issue #442).
//
//   node scripts/fake-model-endpoint.mjs [--port N] [--first-delay-ms N] [--tool-steps N]
//
// Offline and deterministic, no credential: `claude` and `opencode` point their Anthropic base URL
// at it and run a real agent loop against canned answers. The first `--tool-steps` model requests
// that carry tools answer with one Bash tool call (`touch step-N` in the agent's working
// directory); the request after those answers plain text and ends the turn. Requests without
// tools (title generation, quota probes) get a short text answer and are not counted, so
// `GET /requests` is exactly the number of agent model requests — what a cooperative Stop must
// keep from growing. `GET /control` plays the driver's run-control endpoint: it answers
// `{"stop":true}` from the moment the first agent request arrives.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const MESSAGES_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const REQUESTS_PATH = '/requests';
const CONTROL_PATH = '/control';
const BASH_TOOL = /^bash$/i;

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const message = (id, content, stopReason) => ({
    id,
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
});

/** The streaming form of one assistant message, block by block. */
function streamOf(reply) {
    const blocks = reply.content;
    let out = sse('message_start', { type: 'message_start', message: { ...reply, content: [] } });
    blocks.forEach((block, index) => {
        if (block.type === 'tool_use') {
            out += sse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
            });
            out += sse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
            });
        } else {
            out += sse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' },
            });
            out += sse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: block.text },
            });
        }
        out += sse('content_block_stop', { type: 'content_block_stop', index });
    });
    out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reply.stop_reason, stop_sequence: null },
        usage: { output_tokens: 1 },
    });
    return out + sse('message_stop', { type: 'message_stop' });
}

export function createFakeModelEndpoint({ firstDelayMs = 0, toolSteps = 3 } = {}) {
    let agentRequests = 0;
    /** True from the moment the first agent request arrives — what `GET /control` raises a Stop on. */
    let firstInFlight = false;
    const agentReply = (tools) => {
        const step = ++agentRequests;
        const bash = tools.find((tool) => BASH_TOOL.test(tool.name));
        if (step <= toolSteps && bash) {
            return message(
                `msg_${step}`,
                [{ type: 'tool_use', id: `toolu_${step}`, name: bash.name, input: { command: `touch step-${step}`, description: 'touch a marker' } }],
                'tool_use'
            );
        }
        return message(`msg_${step}`, [{ type: 'text', text: 'done' }], 'end_turn');
    };

    const server = createServer((request, reply) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', async () => {
            const url = (request.url ?? '').split('?')[0];
            if (url === REQUESTS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ agentRequests }));
            }
            if (url === CONTROL_PATH) {
                // The driver's control endpoint, played here: a Stop is raised the moment the first
                // agent request arrives, so it always lands INSIDE the first model step.
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ stop: agentRequests > 0 || firstInFlight }));
            }
            if (url === COUNT_TOKENS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ input_tokens: 1 }));
            }
            if (request.method !== 'POST' || url !== MESSAGES_PATH) {
                reply.statusCode = 404;
                return reply.end('not found');
            }
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                // An unparseable body is answered like a tool-less request.
            }
            const tools = Array.isArray(body.tools) ? body.tools : [];
            const isAgentStep = tools.length > 0;
            // The delay is the "stop during a model step" window: the answer to the FIRST agent
            // request is held, so a Stop raised meanwhile lands inside the step.
            if (isAgentStep && !firstInFlight) {
                firstInFlight = true;
                if (firstDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, firstDelayMs));
            }
            const answer = isAgentStep ? agentReply(tools) : message('msg_aux', [{ type: 'text', text: 'ok' }], 'end_turn');
            if (body.stream) {
                reply.setHeader('content-type', 'text/event-stream');
                return reply.end(streamOf(answer));
            }
            reply.setHeader('content-type', 'application/json');
            reply.end(JSON.stringify(answer));
        });
    });

    return {
        get agentRequests() {
            return agentRequests;
        },
        listen: (port = 0, host = '0.0.0.0') =>
            new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const flag = (name, fallback) => {
        const at = process.argv.indexOf(name);
        return at === -1 ? fallback : Number(process.argv[at + 1]);
    };
    const endpoint = createFakeModelEndpoint({
        firstDelayMs: flag('--first-delay-ms', 0),
        toolSteps: flag('--tool-steps', 3),
    });
    const port = await endpoint.listen(flag('--port', 0));
    process.stdout.write(`${port}\n`);
}
