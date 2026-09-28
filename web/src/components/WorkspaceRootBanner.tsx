import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export const WORKSPACE_ROOT_BANNER_TITLE = 'Workspace root not configured';

/**
 * The root-null warning the settings pages share (issue 282): a deployment with no
 * ORG_WORKSPACE_ROOT is a deliberate operator configuration, not a failure, so it is a warn
 * banner and never an error. Each page supplies the sentence that says what the missing root
 * means there. It never offers a button: no member can set the root from the browser.
 */
export function WorkspaceRootBanner({ children }: { children: ReactNode }) {
    return (
        <div className="banner-warn">
            <Icon name="alert-triangle" size={24} />
            <div>
                <p className="banner-title">{WORKSPACE_ROOT_BANNER_TITLE}</p>
                <p>{children}</p>
            </div>
        </div>
    );
}
