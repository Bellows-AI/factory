import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, respondJson } from './http.js';
import { PUBLISH_BODY_LIMIT, type PublishRelay, servePublish } from './publish-control.js';
import {
    cancelPendingQuestions,
    type ControlEntry,
    hasPendingQuestion,
    newControl,
    QUESTION_BODY_LIMIT,
    type QuestionRelay,
    type QuestionResolution,
    readQuestion,
    recordQuestion,
    resolveQuestion,
} from './question-control.js';

/**
 * The per-attempt run-control channel the gate server hosts beside the ad-hoc gate route: the
 * runner's stop poll (`GET /control`) and the agent's questions (`POST /question`,
 * `GET /question/:id`), all keyed by the CONTROL token only — a gate token is no key here, and an
 * unknown or closed token is 401. One entry per token, so one per lease.
 */

/** The run-control poll route the runner's stop poller reads (docker/*-executor/stop-poller.cjs). */
export const CONTROL_PATH = '/control';
/** The draft-publication route beside it: `POST /publish`. */
export const PUBLISH_PATH = '/publish';
/** The question routes beside it: `POST /question`, `GET /question/:questionId`. */
export const QUESTION_PATH = '/question';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYLOAD_TOO_LARGE = 413;

export interface ControlChannel {
    /** Opens the token (idempotent); `relay` carries its questions to the board, `publisher` its draft publishes. */
    open(token: string, relay?: QuestionRelay, publisher?: PublishRelay): void;
    /** Whether a runner has contacted this token — its stop poll, or a question POST. */
    polled(token: string): boolean;
    /** Raises the stop; repeated calls and unknown tokens do nothing. */
    raiseStop(token: string): void;
    /** Ends the token: its stop flag and its questions are dropped, and the runner gets 401. */
    close(token: string): void;
    /** Drops every token — the server is closing. */
    clear(): void;
    /** Settles a pending question; false and no change for an unknown token or id or a settled question. */
    resolveQuestion(token: string, questionId: string, resolution: QuestionResolution): boolean;
    /** Whether a question is pending on the token — the wait a Stop must drain rather than kill. */
    hasPendingQuestion(token: string): boolean;
    /** Turns every pending question of the token into `cancelled`. */
    cancelQuestions(token: string): void;
    /** Serves a control or question request; false when the request is neither. */
    serve(request: IncomingMessage, reply: ServerResponse, auth: string): Promise<boolean>;
}

export function createControlChannel(): ControlChannel {
    const controls = new Map<string, ControlEntry>();

    /** `POST /question` / `GET /question/:id`, once the token is known. */
    const serveQuestion = async (control: ControlEntry, request: IncomingMessage, auth: string) => {
        if (request.method === 'GET') return readQuestion(control, (request.url ?? '').slice(QUESTION_PATH.length + 1));
        const raw = await readBody(request, QUESTION_BODY_LIMIT);
        if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
        // Closed while the body arrived: the entry read before is the dead attempt's.
        if (controls.get(auth) !== control) return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
        return recordQuestion(control, raw);
    };

    /** `POST /publish`: the body names nothing and is only drained, bounded. */
    const serveDraftPublish = async (control: ControlEntry, request: IncomingMessage, auth: string) => {
        if ((await readBody(request, PUBLISH_BODY_LIMIT)) === null) {
            return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
        }
        // Closed while the body arrived: the entry read before is the dead attempt's.
        if (controls.get(auth) !== control) return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
        return servePublish(control.publishing, control.publisher);
    };

    return {
        open(token, relay, publisher) {
            if (!controls.has(token)) controls.set(token, newControl(relay ?? null, publisher ?? null));
        },
        polled: (token) => controls.get(token)?.polled ?? false,
        raiseStop(token) {
            const control = controls.get(token);
            if (control) control.stop = true;
        },
        close: (token) => void controls.delete(token),
        clear: () => controls.clear(),
        resolveQuestion: (token, id, resolution) => {
            const control = controls.get(token);
            return control ? resolveQuestion(control, id, resolution) : false;
        },
        hasPendingQuestion: (token) => {
            const control = controls.get(token);
            return control ? hasPendingQuestion(control) : false;
        },
        cancelQuestions(token) {
            const control = controls.get(token);
            if (control) cancelPendingQuestions(control);
        },
        async serve(request, reply, auth) {
            const url = request.url ?? '';
            const isGet = request.method === 'GET';
            const isControl = isGet && url === CONTROL_PATH;
            const isPublish = request.method === 'POST' && url === PUBLISH_PATH;
            const isQuestion =
                url === QUESTION_PATH ? request.method === 'POST' : isGet && url.startsWith(`${QUESTION_PATH}/`);
            if (!isControl && !isQuestion && !isPublish) return false;
            const control = controls.get(auth);
            if (!control) {
                respondJson(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });
                return true;
            }
            control.polled = true;
            if (isControl) {
                respondJson(reply, HTTP_OK, { stop: control.stop });
                return true;
            }
            const answer = isPublish
                ? await serveDraftPublish(control, request, auth)
                : await serveQuestion(control, request, auth);
            respondJson(reply, answer.status, answer.body);
            return true;
        },
    };
}
