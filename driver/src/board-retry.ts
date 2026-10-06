/** How many times a board call that must land is tried: the verdict, a question report, an expiry. */
export const BOARD_CALL_ATTEMPTS = 5;
const BOARD_CALL_BACKOFF_MS = 1_000;

/**
 * Retries a board call that threw (a 5xx, a dropped connection) with doubling backoff; the last
 * throw propagates. A board VERDICT — 409, 404 — is an answer and returns, so it is never retried.
 * `what` opens the log line ("job <id>: the verdict was not accepted").
 */
export async function withBoardRetry<T>(
    io: { log: (message: string) => void; sleep: (ms: number) => Promise<void> },
    what: string,
    call: () => Promise<T>
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await call();
        } catch (e) {
            if (attempt >= BOARD_CALL_ATTEMPTS) throw e;
            const delayMs = BOARD_CALL_BACKOFF_MS * 2 ** (attempt - 1);
            io.log(`${what}, retrying in ${delayMs}ms: ${(e as Error).message}`);
            await io.sleep(delayMs);
        }
    }
}
