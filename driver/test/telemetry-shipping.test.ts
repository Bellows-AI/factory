import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

describe('runner telemetry shipping', () => {
    it('configures both agents for OTLP/HTTP JSON while keeping prompt and tool bodies private', () => {
        const claude = JSON.parse(read('docker/claude-executor/managed-settings.json')) as {
            env: Record<string, string>;
        };
        const opencode = JSON.parse(read('docker/opencode-executor/opencode-home/otel.json')) as Record<string, string>;

        expect(claude.env).toMatchObject({
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_METRICS_EXPORTER: 'otlp',
            OTEL_LOGS_EXPORTER: 'otlp',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
            OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
            OTEL_LOG_USER_PROMPTS: '0',
            OTEL_LOG_ASSISTANT_RESPONSES: '0',
            OTEL_LOG_TOOL_DETAILS: '0',
        });
        expect(opencode).toEqual({
            endpoint: 'http://collector:4318',
            protocol: 'http/json',
            metricsTemporality: 'delta',
        });
    });

    it.each(['docker/otel-collector.yaml', 'charts/factory/files/collector.yaml'])(
        '%s preserves the loss-aware and privacy-preserving pipeline',
        (relative) => {
            const collector = read(relative);
            expect(collector).toContain('endpoint: 0.0.0.0:4318');
            expect(collector).toContain('encoding: json');
            expect(collector).toContain('compression: none');
            expect(collector).toMatch(
                /retry_on_failure:\n\s+enabled: true\n\s+initial_interval: 5s\n\s+max_elapsed_time: 300s/
            );
            // The chart's collector puts memory_limiter first (it runs under a memory limit); the
            // privacy-preserving part of the pipeline is the same on both.
            expect(collector).toMatch(
                /processors: \[(memory_limiter, )?filter\/drop-cost, attributes\/strip-identity, batch\]/
            );
            expect(collector).toMatch(/processors: \[(memory_limiter, )?attributes\/strip-identity, batch\]/);
            expect(collector).toContain('exporters: [otlp_http/dashboard]');
        }
    );

    it('renders the Helm collector config and authenticates its dashboard hop', () => {
        const config = read('charts/factory/files/collector.yaml');
        const template = read('charts/factory/templates/collector.yaml');

        expect(config).toContain('X-Factory-Ingest-Token: $' + '{env:INGEST_TOKEN}');
        expect(template).toContain('{{ tpl (.Files.Get "files/collector.yaml") . | indent 8 }}');
        expect(template).toContain('- name: INGEST_TOKEN');
    });
});
