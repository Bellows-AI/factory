import { Link, useSearchParams } from 'react-router-dom';

/** The one place a settings page may send the member back to: the composer that sent them. */
export const DRAFT_RETURN_PATH = '/tasks/new';
const RETURN_PARAM = 'return';

/** A settings link that remembers the composer is waiting. */
export function withDraftReturn(to: string): string {
    return `${to}?${RETURN_PARAM}=${DRAFT_RETURN_PATH}`;
}

/**
 * The way back to a task draft in progress. It accepts only the exact composer path — never an
 * arbitrary `?return=`, which would make every settings page an open redirect — and it only offers
 * the link: nothing navigates on its own, so the member finishes here first.
 */
export function DraftReturnBanner() {
    const [params] = useSearchParams();
    if (params.get(RETURN_PARAM) !== DRAFT_RETURN_PATH) return null;
    return (
        <p className="banner-info">
            You have a task draft in progress. <Link to={DRAFT_RETURN_PATH}>Back to new task</Link>
        </p>
    );
}

/**
 * A settings link that keeps the way back only when this page already has it — the executor
 * dialog's detour to the environment editor (issue 261) forwards the composer's return, and a visit
 * that did not come from the composer gains none.
 */
export function useDraftReturnHref(to: string): string {
    const [params] = useSearchParams();
    return params.get(RETURN_PARAM) === DRAFT_RETURN_PATH ? withDraftReturn(to) : to;
}
