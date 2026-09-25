import type { ReactNode } from 'react';
import { PRODUCT_NAME } from '../brand.js';

/**
 * The compact chrome every public (pre-sign-in) page shares: the brand, one line of
 * page context, and an actions cell. It is not a second shell — no navigation, no session,
 * no data — just the placement seam that keeps the gate and onboarding recognizably the same
 * product, and where the theme control lands later (issue 187's Slice E 2/4).
 *
 * No `h1` lives here: each page owns exactly one, and the header must not compete for it.
 */
export function PublicPageHeader({ context, actions }: { context?: string; actions?: ReactNode }) {
    return (
        <header className="public-header">
            <span className="public-brand">{PRODUCT_NAME}</span>
            {context ? <span className="public-context">{context}</span> : null}
            <span className="public-header-actions">{actions ?? null}</span>
        </header>
    );
}
