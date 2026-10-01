// Assemble the handoff from fresh screenshots produced by the documented Playwright run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repo = path.resolve(here, '../../..');
    const source = path.join(repo, 'artifacts/ui');
    const since = fs.statSync('/tmp/factory-designer-capture.log').birthtimeMs;
    const images = path.join(here, 'screenshots');
    fs.mkdirSync(images, { recursive: true });
    const manifest = [];
    function add(file, group, title, caption, route) {
        const from = path.join(source, file);
        const stat = fs.statSync(from);
        if (stat.mtimeMs < since) throw new Error('Refusing stale screenshot: ' + file);
        const name = file.replace(/^matrix\//, '');
        fs.copyFileSync(from, path.join(images, name));
        const png = fs.readFileSync(from);
        manifest.push({ file: 'screenshots/' + name, source: 'artifacts/ui/' + file, group, title, caption, route,
            capturedAt: stat.mtime.toISOString(), imageWidth: png.readUInt32BE(16), imageHeight: png.readUInt32BE(20) });
    }
    const pages = [
        ['dashboard', '/', 'Dashboard', 'Usage summary, range and scope, token chart, attribution tables and recent tasks. Synthetic values; inspect hierarchy and coverage language.'],
        ['tasks', '/tasks', 'Task inbox', 'State filters, search, repository and author, sort, task rows and Load more. Seed titles are intentionally repetitive.'],
        ['tasks-new', '/tasks/new', 'New task', 'Request, execution context, default workflow and setup blockers. This fixture has no configured personal executor.'],
        ['settings', '/settings', 'Configuration overview', 'Readiness items pair a state with a fact and an action. Open-mode fixture has no configured checkout workspace.'],
        ['settings-organization', '/settings/organization', 'Organization settings', 'Organization identity, environment editor and scope explanation.'],
        ['settings-workspace', '/settings/workspace', 'Workspace settings', 'Personal workspace/environment scope and unavailable-workspace messaging.'],
        ['settings-repos', '/settings/repos', 'Repository settings', 'Open-mode unavailable-workspace state. See authenticated repository selection below for the populated pattern.'],
        ['settings-executors', '/settings/executors', 'Executor settings', 'Open-mode configuration state. See authenticated executor examples below for a configured profile.'],
        ['settings-workflows', '/settings/workflows', 'Workflow settings', 'Default optional steps and named workflow management; distinguish personal defaults from named definitions.'],
        ['account', '/account', 'Account', 'Local identity in open mode; not a signed-in GitHub customer account.'],
    ];
    for (const [slug, route, title, caption] of pages) {
        add(`matrix/${slug}_default_dark_1440.png`, 'Current pages', title + ' · dark desktop', caption, route);
    }
    for (const [slug, route, title, caption] of pages.filter(([slug]) => ['dashboard', 'tasks', 'tasks-new', 'settings-workflows'].includes(slug))) {
        add(`matrix/${slug}_default_light_1440.png`, 'Theme comparisons', title + ' · light desktop', caption, route);
        add(`matrix/${slug}_default_dark_390.png`, 'Responsive layouts', title + ' · 390px phone', caption, route);
    }
    add('matrix/tasks_default_dark_320.png', 'Responsive layouts', 'Task inbox · 320px', 'Minimum-width stress case for row wrapping, filters and actions.', '/tasks');
    add('matrix/dashboard_default_dark_768.png', 'Responsive layouts', 'Dashboard · 768px', 'Intermediate-width navigation and content layout.', '/');
    const extras = [
        ['task-detail-rich.png', 'Task work record', 'Task detail · result and checks', 'Synthetic completed run with summary, verification and publication metadata.', '/tasks/:id'],
        ['task-detail-thread.png', 'Task work record', 'Task detail · follow-up conversation', 'Multiple runs within one task. Compare request, response, metadata and disclosures.', '/tasks/:id'],
        ['task-detail-done.png', 'Task work record', 'Task marked done', 'Human completion decision is separate from a successful run.', '/tasks/:id'],
        ['task-detail-360.png', 'Responsive layouts', 'Task detail · 360px', 'Outcome and conversation on a phone; inspect wrapping and action placement.', '/tasks/:id'],
        ['task-remove-dialog.png', 'Interaction states', 'Remove task confirmation', 'Destructive action with consequences and a safe cancellation path.', '/tasks/:id'],
        ['task-remove-refused.png', 'Interaction states', 'Removal refused by server', 'Dialog retains context and presents the refusal reason. This is an intentional test response.', '/tasks/:id'],
        ['composer-steps-open.png', 'Interaction states', 'Default workflow options', 'Optional steps disclosed within task creation.', '/tasks/new'],
        ['matrix/dashboard_range-dialog-open_dark_1440.png', 'Interaction states', 'Custom range dialog', 'Draft date range with explicit apply action.', '/'],
        ['matrix/dashboard_user-menu-open_dark_1440.png', 'Interaction states', 'Account menu', 'Menu surface, hierarchy and trigger relationship.', '/'],
        ['matrix/inbox_drawer-open_dark_390.png', 'Interaction states', 'Mobile navigation drawer', 'Organization and navigation move into a focused overlay.', '/tasks'],
        ['board-degraded.png', 'Interaction states', 'Partial data failure', 'Board refresh fails while previous rows remain; telemetry is still available.', '/'],
        ['settings-repos.png', 'Authenticated setup', 'Repository selection', 'Authenticated synthetic organization with repository choices and setup controls.', '/settings/repos'],
        ['settings-workspace-env.png', 'Authenticated setup', 'Workspace environment editor', 'Environment controls in an authenticated synthetic workspace context.', '/settings/workspace'],
        ['settings-executors.png', 'Authenticated setup', 'Configured executor', 'Named execution profile after creation in the disposable test environment.', '/settings/executors'],
        ['settings-executor-help.png', 'Authenticated setup', 'Executor configuration dialog', 'Executor-specific help and form context.', '/settings/executors'],
        ['onboarding-explained.png', 'Entry', 'Organization onboarding', 'Synthetic GitHub identity, organization choice and explanation of consequences.', '/onboarding'],
        ['matrix/onboarding_default_light_390.png', 'Entry', 'Onboarding · light phone', 'Narrow-screen organization/repository selection.', '/onboarding'],
        ['matrix/signin-gate_default_dark_390.png', 'Entry', 'Sign-in · dark phone', 'Signed-out entry gate with appearance control.', 'Sign-in gate'],
    ];
    for (const row of extras) add(...row);
    fs.writeFileSync(path.join(here, 'capture-manifest.json'), JSON.stringify({ revision: 'c503351', data: 'synthetic disposable E2E databases', screenshots: manifest }, null, 2) + '\n');
    const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    function inline(s) {
        return escape(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    }
    function markdown(s) {
        const lines = s.split('\n'); let html = ''; let list = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) { if (list) { html += '</ul>'; list = false; } continue; }
            if (line.startsWith('|')) {
                if (list) { html += '</ul>'; list = false; }
                const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]); i--;
                html += '<div class="table-scroll"><table>' + rows.filter(r => !/^\|[\s:|-]+\|$/.test(r)).map((r, n) => '<tr>' + r.slice(1, -1).split('|').map(cell => `<${n ? 'td' : 'th'}>${inline(cell.trim())}</${n ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table></div>'; continue;
            }
            const heading = /^(#{1,3}) (.*)/.exec(line);
            if (heading) { if (list) { html += '</ul>'; list = false; } html += `<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`; continue; }
            if (/^(- |\d+\. )/.test(line)) { if (!list) { html += '<ul>'; list = true; } html += '<li>' + inline(line.replace(/^(- |\d+\. )/, '')) + '</li>'; continue; }
            html += '<p>' + inline(line) + '</p>';
        }
        return html + (list ? '</ul>' : '');
    }
    const groups = [...new Set(manifest.map(s => s.group))];
    const gallery = groups.map(group => `<section><h3>${escape(group)}</h3><div class="gallery">` + manifest.filter(s => s.group === group).map((s) => `<figure><a href="${s.file}" target="_blank" rel="noopener"><img src="${s.file}" loading="lazy" alt="${escape(s.title)}"></a><figcaption><strong>${escape(s.title)}</strong><p>${escape(s.caption)}</p><small>${escape(s.route)} · image ${s.imageWidth} × ${s.imageHeight}</small></figcaption></figure>`).join('') + '</div></section>').join('');
    fs.writeFileSync(path.join(here, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bellows — UI kit designer handoff</title><style>
    :root{font-family:system-ui,sans-serif;color:#172331;background:#f3f5f7;line-height:1.6}body{margin:0}header,main{max-width:1200px;margin:auto;padding:32px}header{padding-bottom:8px}h1{font-size:clamp(28px,4vw,46px);line-height:1.15}h2,h3,h4{line-height:1.3}a{color:#075c9d}nav{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}details{background:white;border:1px solid #d6dee5;border-radius:12px;padding:20px;margin:18px 0}summary{font-size:22px;font-weight:650;cursor:pointer}article{max-width:1050px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #d6dee5;padding:12px;text-align:left;vertical-align:top}th{background:#eef3f7}.table-scroll{overflow:auto}code{background:#eef3f7;padding:2px 4px;overflow-wrap:anywhere}li{margin:8px 0}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}figure{margin:0;background:white;border:1px solid #d6dee5;border-radius:10px;overflow:hidden}figure img{width:100%;height:280px;object-fit:cover;object-position:top;background:#e5ebf0}figcaption{padding:16px}figcaption p{margin:8px 0}small{color:#465a6b}.notice{border-left:4px solid #ca820f;padding:12px 20px;background:#fff4dc}a:focus-visible,summary:focus-visible{outline:3px solid #0075b9;outline-offset:4px}@media print{header,main{padding:12px}details{border:0}.gallery{grid-template-columns:1fr 1fr}figure{break-inside:avoid}nav{display:none}}
    </style></head><body><header><p>DESIGN HANDOFF · 26 SEPTEMBER 2026</p><h1>Bellows: delegation with a readable work record</h1><p>Product narrative, reusable component inventory, and ${manifest.length} fresh screenshots of the current app.</p><nav><a href="#brief">Narrative</a><a href="#components">UI kit inventory</a><a href="#screenshots">Screenshots</a><a href="CAPTURE.md">Capture notes</a></nav><p class="notice">Current implementation, synthetic data. Screenshots are references for redesign, not proposed designs. Browser verification: 78 checks passed, 13 failed; see capture notes for limits.</p></header><main><details open id="brief"><summary>Product narrative and designer assignment</summary><article>${markdown(fs.readFileSync(path.join(here, 'BRIEF.md'), 'utf8'))}</article></details><details id="components"><summary>Reusable components and state coverage</summary><article>${markdown(fs.readFileSync(path.join(here, 'COMPONENTS.md'), 'utf8'))}</article></details><section id="screenshots"><h2>Current UI — screenshot gallery</h2><p>Click any image to inspect the original at full resolution. Captions identify fixture limitations. Dark and light desktop captures use a 1440px viewport; responsive captures name their widths.</p>${gallery}</section></main></body></html>`);
    console.log(JSON.stringify({ screenshots: manifest.length, imageBytes: manifest.reduce((sum, s) => sum + fs.statSync(path.join(here, s.file)).size, 0), html: path.join(here, 'index.html') }));
} catch (error) { console.error(String(error)); process.exitCode = 1; }
