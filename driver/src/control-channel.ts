import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, respondJson } from './http.js';
import { PUBLISH_BODY_LIMIT, type PublishRelay, servePublish } from './publish-control.js';
import { REVIEW_BODY_LIMIT, type ReviewRelay, serveReviewRead, serveReviewRequest } from './review-control.js';
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
/** The reviewer routes beside them (issue #549): `POST /review`, `GET /review/:key`. */
export const REVIEW_PATH = '/review';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYLOAD_TOO_LARGE = 413;

export interface ControlChannel {
    /**
     * Opens the token (idempotent); `relay` carries its questions to the board, `publisher` its draft
     * publishes and `reviewer` its named-reviewer requests (none on a run that may not invoke one).
     */
    open(token: string, relay?: QuestionRelay, publisher?: PublishRelay, reviewer?: ReviewRelay): void;
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

type Route = 'control' | 'publish' | 'question' | 'review';

/** A path that is a POST of its own, or a GET of `<path>/<id>`: the shape the question and review routes share. */
const isPostOrGetOf = (request: IncomingMessage, path: string): boolean => {
    const url = request.url ?? '';
    return url === path ? request.method === 'POST' : request.method === 'GET' && url.startsWith(`${path}/`);
};

/** Which control route a request is, or null when it is none of them. */
function routeOf(request: IncomingMessage): Route | null {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === CONTROL_PATH) return 'control';
    if (request.method === 'POST' && url === PUBLISH_PATH) return 'publish';
    if (isPostOrGetOf(request, QUESTION_PATH)) return 'question';
    return isPostOrGetOf(request, REVIEW_PATH) ? 'review' : null;
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

    /** `POST /review` / `GET /review/:key`, once the token is known. */
    const serveReview = async (control: ControlEntry, request: IncomingMessage, auth: string) => {
        if (request.method === 'GET') {
            return serveReviewRead(control.reviewer, (request.url ?? '').slice(REVIEW_PATH.length + 1));
        }
        const raw = await readBody(request, REVIEW_BODY_LIMIT);
        if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
        // Closed while the body arrived: the entry read before is the dead attempt's.
        if (controls.get(auth) !== control) return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
        return serveReviewRequest(control.reviewing, control.reviewer, raw);
    };

    return {
        open(token, relay, publisher, reviewer) {
            if (!controls.has(token)) {
                controls.set(token, newControl(relay ?? null, publisher ?? null, reviewer ?? null));
            }
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
            const route = routeOf(request);
            if (route === null) return false;
            const control = controls.get(auth);
            if (!control) {
                respondJson(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });
                return true;
            }
            control.polled = true;
            if (route === 'control') {
                respondJson(reply, HTTP_OK, { stop: control.stop });
                return true;
            }
            const serveRoute = { publish: serveDraftPublish, review: serveReview, question: serveQuestion }[route];
            const answer = await serveRoute(control, request, auth);
            respondJson(reply, answer.status, answer.body);
            return true;
        },
    };
}
