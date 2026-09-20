import type { ReactNode } from 'react';

/**
 * The page's one heading and everything that belongs beside it. Every routed page renders
 * exactly one of these; the `h1` inside is the page's only `h1`, and panel headings below are
 * `h2`s that never restate the title. Presentational by contract — no fetching, no route
 * inspection, no Factory knowledge — so a static render is a complete render.
 *
 * Slots: `eyebrow` (the section above the title), `title` (the `h1`), `description` (the
 * leading column's second line), `meta` (state beside the title — pills, clocks, timestamps)
 * and `actions` (the page's buttons, siblings of the heading, never inside it). An empty slot
 * renders nothing — no blank wrappers.
 */
export function PageHeader({
    eyebrow,
    title,
    description,
    meta,
    actions,
}: {
    eyebrow?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    meta?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="page-header">
            {eyebrow ? <p className="page-header-eyebrow">{eyebrow}</p> : null}
            <div className="page-header-leading">
                <h1>{title}</h1>
                {description ? <p className="page-header-description">{description}</p> : null}
            </div>
            {meta ? <div className="page-header-meta">{meta}</div> : null}
            {actions ? <div className="page-header-actions">{actions}</div> : null}
        </header>
    );
}
