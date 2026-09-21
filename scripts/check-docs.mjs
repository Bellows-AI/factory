import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repoRoot, 'docs-site', 'src', 'content', 'docs');

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(absolute) : [absolute];
    });
}

function candidatesFor(source, rawTarget) {
    const withoutFragment = rawTarget.split('#', 1)[0].split('?', 1)[0];
    if (!withoutFragment) return [];

    let decoded;
    try {
        decoded = decodeURIComponent(withoutFragment);
    } catch {
        decoded = withoutFragment;
    }

    const base = decoded.startsWith('/factory/')
        ? path.join(docsRoot, decoded.slice('/factory/'.length))
        : path.resolve(path.dirname(source), decoded);

    if (path.extname(base)) return [base];
    return [base, `${base}.md`, `${base}.mdx`, path.join(base, 'index.md'), path.join(base, 'index.mdx')];
}

const errors = [];
const files = walk(docsRoot).filter((file) => /\.mdx?$/.test(file));

for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatter) {
        errors.push(`${relative}: missing frontmatter`);
    } else {
        if (!/^title:\s*\S+/m.test(frontmatter[1])) errors.push(`${relative}: missing title`);
        if (!/^description:\s*\S+/m.test(frontmatter[1])) errors.push(`${relative}: missing description`);

        const editUrl = frontmatter[1].match(/^editUrl:\s*(\S+)/m)?.[1];
        if (path.basename(file) === '404.md') {
            if (editUrl !== 'false') errors.push(`${relative}: the generated 404 page must disable its edit link`);
        } else {
            const expected = `https://github.com/Bellows-AI/factory/edit/main/${relative}`;
            if (editUrl !== expected) errors.push(`${relative}: editUrl must be ${expected}`);
        }
    }

    const prose = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, '');
        if (/^(?:[a-z]+:|#)/i.test(target)) continue;
        if (target.startsWith('/') && !target.startsWith('/factory/')) {
            errors.push(`${relative}: site-absolute link must start with /factory/: ${target}`);
            continue;
        }

        const candidates = candidatesFor(file, target);
        if (candidates.length && !candidates.some((candidate) => fs.existsSync(candidate))) {
            errors.push(`${relative}: broken internal link ${target}`);
        }
    }
}

if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.log(`Checked ${files.length} documentation pages and their internal links.`);
}
