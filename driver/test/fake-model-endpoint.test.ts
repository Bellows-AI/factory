import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The scripted model endpoint behind the `test:jobs` cooperative-Stop lane (issue #442). The lane
 * itself needs docker and the real CLIs; what is pinned here is the endpoint's protocol, so a lane
 * failure is never the stub's fault, and the lane's wiring.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENDPOINT = join(ROOT, 'scripts/fake-model-endpoint.mjs');

interface Endpoint {
    agentRequests: number;
    listen: (port?: number, host?: string) => Promise<number>;
    close: () => Promise<void>;
}
const open: Endpoint[] = [];
afterEach(async () => {
    for (const endpoint of open.splice(0)) await endpoint.close();
});

async function start(options: { firstDelayMs?: number; toolSteps?: number; ask?: boolean; askProse?: boolean } = {}) {
    const { createFakeModelEndpoint } = (await import(pathToFileURL(ENDPOINT).href)) as {
        createFakeModelEndpoint: (options: object) => Endpoint;
    };
    const endpoint = createFakeModelEndpoint(options);
    open.push(endpoint);
    const port = await endpoint.listen(0, '127.0.0.1');
    return { endpoint, url: `http://127.0.0.1:${port}` };
}

const agentRequest = (url: string, stream: boolean) =>
    fetch(`${url}/v1/messages?beta=true`, {
        method: 'POST',
        body: JSON.stringify({ stream, tools: [{ name: 'Bash' }, { name: 'Read' }], messages: [] }),
    });

describe('the scripted model endpoint', () => {
    it('answers tool calls for the scripted steps, then ends the turn in text', async () => {
        const { endpoint, url } = await start({ toolSteps: 2 });

        const first = (await (await agentRequest(url, false)).json()) as {
            stop_reason: string;
            content: { name?: string; input?: { command: string } }[];
        };
        const second = (await (await agentRequest(url, false)).json()) as typeof first;
        const third = (await (await agentRequest(url, false)).json()) as typeof first;

        expect(first.stop_reason).toBe('tool_use');
        expect(first.content[0]).toMatchObject({ name: 'Bash', input: { command: 'touch step-1' } });
        expect(second.content[0].input?.command).toBe('touch step-2');
        expect(third.stop_reason).toBe('end_turn');
        expect(endpoint.agentRequests).toBe(3);
    });

    it('streams the same answer as server-sent events', async () => {
        const { url } = await start();

        const body = await (await agentRequest(url, true)).text();

        expect(body).toContain('event: message_start');
        expect(body).toContain('"type":"tool_use"');
        expect(body).toContain('"partial_json":"{\\"command\\":\\"touch step-1\\"');
        expect(body.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
    });

    it('counts only requests that carry tools, and raises the stop inside the first step', async () => {
        const { endpoint, url } = await start({ firstDelayMs: 150 });
        const control = async () => ((await (await fetch(`${url}/control`)).json()) as { stop: boolean }).stop;

        expect(await control()).toBe(false);
        await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify({ stream: false, messages: [] }) });
        expect(endpoint.agentRequests).toBe(0);
        expect(await control()).toBe(false);

        const pending = agentRequest(url, false);
        await new Promise((resolve) => setTimeout(resolve, 40));
        // The first agent request is still being held: the Stop is already up, mid-step.
        expect(await control()).toBe(true);
        expect(endpoint.agentRequests).toBe(0);
        await pending;
        expect(endpoint.agentRequests).toBe(1);
        await expect((await fetch(`${url}/requests`)).json()).resolves.toEqual({ agentRequests: 1 });
    });
});

describe('the scripted model endpoint in ask mode (issue #226)', () => {
    const askRequest = (url: string, messages: unknown[]) =>
        fetch(`${url}/v1/messages`, {
            method: 'POST',
            body: JSON.stringify({ stream: false, tools: [{ name: 'AskUserQuestion' }, { name: 'Bash' }], messages }),
        }).then((response) => response.json() as Promise<{ stop_reason: string; content: Record<string, any>[] }>);

    it('asks one Red-or-Blue question first, then reports the answer the tool_result carries', async () => {
        const { url } = await start({ ask: true });

        const first = await askRequest(url, []);
        expect(first.stop_reason).toBe('tool_use');
        expect(first.content[0]).toMatchObject({ type: 'tool_use', name: 'AskUserQuestion' });
        const [question] = first.content[0].input.questions;
        expect(question.options.map((option: { label: string }) => option.label)).toEqual(['Red', 'Blue']);

        const answered = await askRequest(url, [
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'User answered: "Blue"' }],
            },
        ]);
        expect(answered.content[0].text).toBe('ANSWER=Blue');

        const unanswered = await askRequest(url, [
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'denied', is_error: true }],
            },
        ]);
        expect(unanswered.content[0].text).toBe('ANSWER=missing');
    });

    it('plays the board: pending on the first poll, then answered, with the POSTs counted', async () => {
        const { url } = await start({ ask: true });
        const poll = async () =>
            (await fetch(`${url}/question/toolu_ask`)).json() as Promise<{ state: string; answers?: object }>;
        const posts = async () =>
            ((await (await fetch(`${url}/questions`)).json()) as { questionPosts: number }).questionPosts;

        expect(await posts()).toBe(0);
        await fetch(`${url}/question`, { method: 'POST', body: '{}' });
        expect(await posts()).toBe(1);
        expect(await poll()).toEqual({ state: 'pending' });
        expect(await poll()).toEqual({
            state: 'answered',
            answers: { 'Which colour should the report use?': 'Blue' },
        });
    });
});

describe('the scripted model endpoint in ask-prose mode (issue #226)', () => {
    const request = (url: string, body: object) =>
        fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify({ stream: false, ...body }) }).then(
            (response) => response.json() as Promise<{ stop_reason: string; content: Record<string, any>[] }>
        );
    const agent = (url: string) => request(url, { tools: [{ name: 'AskUserQuestion' }, { name: 'Bash' }], messages: [] });
    const hook = (url: string) =>
        request(url, { messages: [{ role: 'user', content: 'You decide whether an autonomous coding agent may stop.' }] });
    const hooks = async (url: string) =>
        ((await (await fetch(`${url}/hooks`)).json()) as { hookRequests: number }).hookRequests;

    it('ends the first turn on the prose question, then asks AskUserQuestion after the hook blocks', async () => {
        const { endpoint, url } = await start({ askProse: true });

        const first = await agent(url);
        expect(first.stop_reason).toBe('end_turn');
        expect(first.content[0].text).toBe('Which one should I use: Red or Blue?');

        const verdict = await hook(url);
        expect(JSON.parse(verdict.content[0].text)).toMatchObject({ ok: false });
        expect(await hooks(url)).toBe(1);

        const second = await agent(url);
        expect(second.content[0]).toMatchObject({ type: 'tool_use', name: 'AskUserQuestion' });

        // The evaluation after the answer is stop_hook_active territory: allowed, not an agent request.
        expect(JSON.parse((await hook(url)).content[0].text)).toEqual({ ok: true });
        expect(endpoint.agentRequests).toBe(2);
    });
});

describe('the test-jobs ask lane', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

    it('runs the real claude image against the endpoint in ask mode', () => {
        expect(script).toContain('ask_lane');
        expect(script).toContain('ask_lane tool --ask');
        expect(script).toContain('fake-model-endpoint.mjs "$flag"');
        expect(script).toContain('ANSWER=Blue');
    });

    it('runs the prose mode through the Stop hook', () => {
        expect(script).toContain('ask_lane prose --ask-prose');
        expect(script).toContain('the Stop hook turned the prose question into AskUserQuestion');
    });
});

describe('the test-jobs cooperative-Stop lane', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

    it('drives both real executor images against the scripted endpoint', () => {
        expect(script).toContain('scripts/fake-model-endpoint.mjs');
        expect(script).toContain('stop_lane claude');
        expect(script).toContain('stop_lane opencode');
        expect(script).toContain('makes no model request after the stop');
    });
});
