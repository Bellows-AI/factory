import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
    site: 'https://bellows-ai.github.io',
    base: '/factory',
    trailingSlash: 'always',
    integrations: [
        starlight({
            title: 'Factory',
            description: 'Install, configure, operate, and extend the Factory software engineering control plane.',
            favicon: '/favicon.svg',
            social: [
                {
                    icon: 'github',
                    label: 'Factory on GitHub',
                    href: 'https://github.com/Bellows-AI/factory',
                },
            ],
            customCss: ['./src/styles/custom.css'],
            sidebar: [
                {
                    label: 'Overview',
                    items: [
                        { label: 'What is Factory?', slug: 'overview' },
                        { label: 'Capabilities', slug: 'capabilities' },
                    ],
                },
                {
                    label: 'Getting started',
                    items: [
                        { label: 'Choose a deployment', slug: 'getting-started/deployment-options' },
                        { label: 'Local development', slug: 'getting-started/local-development' },
                        { label: 'Kubernetes and Helm', slug: 'getting-started/kubernetes' },
                        { label: 'GitHub authentication', slug: 'getting-started/github-authentication' },
                    ],
                },
                {
                    label: 'Concepts',
                    items: [
                        { label: 'System architecture', slug: 'concepts/architecture' },
                        { label: 'Organizations and workspaces', slug: 'concepts/organizations-workspaces' },
                        { label: 'Tasks and executors', slug: 'concepts/tasks-executors' },
                        { label: 'Telemetry and metrics', slug: 'concepts/telemetry-metrics' },
                    ],
                },
                {
                    label: 'Guides',
                    items: [
                        { label: 'Run and review tasks', slug: 'guides/run-tasks' },
                        { label: 'Configure runner environment', slug: 'guides/runner-environment' },
                        { label: 'Workflows, gates, and publishing', slug: 'guides/workflows-gates-publishing' },
                    ],
                },
                {
                    label: 'Operations',
                    items: [
                        { label: 'Health and observability', slug: 'operations/health-observability' },
                        { label: 'Database and upgrades', slug: 'operations/database-upgrades' },
                        { label: 'Security', slug: 'operations/security' },
                        { label: 'Troubleshooting', slug: 'operations/troubleshooting' },
                        { label: 'Known limitations', slug: 'operations/known-limitations' },
                    ],
                },
                {
                    label: 'Reference',
                    items: [
                        { label: 'Configuration', slug: 'reference/configuration' },
                        { label: 'Helm values', slug: 'reference/helm-values' },
                        { label: 'HTTP API', slug: 'reference/http-api' },
                    ],
                },
            ],
        }),
    ],
});
