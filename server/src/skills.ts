import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSkillFrontmatter, type Skill } from '@factory-ai/core';

/**
 * The skills the runner images bake: `docker/skills/*` at a depth that resolves the same from
 * `src/` and `dist/` — the checkout's directory locally, `/app/docker/skills` in the image. A
 * missing directory or an unreadable SKILL.md throws, so a board never advertises a catalog it
 * cannot check requirements against.
 */
export function readSkillCatalog(dir: string | URL = new URL('../../docker/skills/', import.meta.url)): Skill[] {
    const root = dir instanceof URL ? fileURLToPath(dir) : dir;
    let names: string[];
    try {
        names = readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        throw new Error(`cannot read the skills directory at ${root}`, { cause: error });
    }
    return names.map((name) => {
        const path = `${root}/${name}/SKILL.md`;
        try {
            return parseSkillFrontmatter(readFileSync(path, 'utf8'), name);
        } catch (error) {
            throw new Error(`cannot load the skill at ${path}`, { cause: error });
        }
    });
}

let catalog: Skill[] | null = null;

/** The shipped catalog, read once per process. */
export function skillCatalog(): Skill[] {
    catalog ??= readSkillCatalog();
    return catalog;
}
