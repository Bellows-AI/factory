import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdoptionNotice } from '../src/components/AdoptionNotice.js';

describe('AdoptionNotice', () => {
    const legacy = [
        { id: 'bellows-ai', name: 'Bellows AI' },
        { id: 'leeloo', name: 'Leeloo AI' },
    ];

    it('fills in the adopt command when the deployment names one unambiguous target', () => {
        const html = renderToStaticMarkup(<AdoptionNotice legacyOrganizations={legacy} target={{ id: '157704433' }} />);
        expect(html).toContain('npm run adopt');
        expect(html).toContain('--installation 157704433');
        expect(html).toContain('--from bellows-ai');
        expect(html).toContain('--from leeloo');
        expect(html).toContain('; ');
    });

    it('shows the generic form when several installations make the pairing a guess', () => {
        // The command names `<id>` placeholders: an operator reading it decides which legacy
        // org belongs to which installation, exactly as `--from` exists for. A filled-in
        // pairing here would re-home another org's history into the viewer's own.
        const html = renderToStaticMarkup(
            <AdoptionNotice legacyOrganizations={[{ id: 'bellows-ai', name: 'Bellows AI' }]} target={null} />
        );
        expect(html).toContain('--installation &lt;id&gt;');
        expect(html).toContain('--from &lt;legacy-org-id&gt;');
        expect(html).not.toContain('157704433');
    });

    it('renders nothing once every organization is an installation', () => {
        const html = renderToStaticMarkup(<AdoptionNotice legacyOrganizations={[]} target={{ id: '1' }} />);
        expect(html).toBe('');
    });
});
