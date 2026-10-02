import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/*
 * Issue #363: the EKS prerequisites live in four places — the docs section that carries them,
 * the ownership sentence that closes the standalone-pod caveat, and the pointers from the chart
 * surfaces an operator actually reads first (the NetworkPolicy template comment, the values
 * comments, the chart README). Each pin below is a fact the issue demands be stated; a docs edit
 * that drops one fails here instead of at an operator's cluster.
 */
const kubernetesDocs = readFileSync(join(ROOT, 'docs/kubernetes.md'), 'utf8');
const netpolTemplate = readFileSync(join(ROOT, 'charts/factory/templates/runner-networkpolicy.yaml'), 'utf8');
const chartValues = readFileSync(join(ROOT, 'charts/factory/values.yaml'), 'utf8');
const chartReadme = readFileSync(join(ROOT, 'charts/factory/README.md'), 'utf8');

describe('the EKS prerequisites record', () => {
    it('states the node and add-on prerequisites in docs/kubernetes.md', () => {
        expect(kubernetesDocs).toContain('EKS prerequisites');
        // The node-level IMDS defence the blockedCidrs rule cannot make on its own.
        expect(kubernetesDocs).toContain('httpPutResponseHopLimit');
        // The VPC CNI add-on flag without which the NetworkPolicy object is inert.
        expect(kubernetesDocs).toContain('enableNetworkPolicy');
        // The metrics API provider absent from EKS by default; vitals degrade to null without it.
        expect(kubernetesDocs).toContain('metrics-server');
        // Fargate is out entirely: no network policy, no metrics API, no node.
        expect(kubernetesDocs).toContain('Fargate');
    });

    it('states the VPC-endpoint answer for the blocked private ranges', () => {
        expect(kubernetesDocs).toContain('VPC endpoint');
        expect(kubernetesDocs).toContain('allowedCidrs');
    });

    it('records that declared-service pods are owned, closing the standalone-pod caveat', () => {
        expect(kubernetesDocs).toContain('ownerReference');
        expect(kubernetesDocs).toContain('standalone');
    });

    it('points the NetworkPolicy surfaces at the EKS enforcement prerequisite', () => {
        // The template header comment, the values comment and the chart README row all name the
        // add-on flag and the doc that carries the rest.
        for (const surface of [netpolTemplate, chartValues, chartReadme]) {
            expect(surface).toContain('enableNetworkPolicy');
            expect(surface).toContain('docs/kubernetes.md');
        }
    });
});

/*
 * Issue #382. The isolation record is split across four documents on purpose — an operator reads
 * kubernetes.md, a reviewer reads security.md, somebody chasing a leaked file reads workspace.md,
 * and somebody deciding whether a green run means anything reads executor-testing.md. Each claim
 * below is one the issue demands be STATED, and each is the kind a later edit drops without
 * noticing, because dropping it makes the document read better rather than worse: the honest
 * limits are the ugly sentences.
 */
const securityDocs = readFileSync(join(ROOT, 'docs/security.md'), 'utf8');
const workspaceDocs = readFileSync(join(ROOT, 'docs/workspace.md'), 'utf8');
const testingDocs = readFileSync(join(ROOT, 'docs/executor-testing.md'), 'utf8');
const jobsDocs = readFileSync(join(ROOT, 'docs/jobs.md'), 'utf8');

/**
 * Prose wraps at 100 columns, so a sentence worth pinning is usually split across a line break and
 * a literal needle that reads fine here fails for a reason that has nothing to do with the claim.
 * Collapsing runs of whitespace means these pins survive a reflow and fail only when the SENTENCE
 * goes — which is the thing they are meant to protect.
 */
const prose = (doc: string): string => doc.replace(/\s+/g, ' ');

describe('the executor isolation record (#382)', () => {
    // The claim the issue forbids, in the one document most likely to drift into making it.
    it('refuses to claim kernel or VM isolation from ordinary pod hardening', () => {
        expect(securityDocs).toContain('not kernel isolation and it is not VM isolation');
        expect(securityDocs).toContain('shares one host kernel');
        // And it says what WOULD give one, so the limit is actionable rather than just a warning.
        expect(securityDocs).toMatch(/gVisor|Kata|Firecracker/);
    });

    it('states the controls and that they are required, not merely set', () => {
        for (const needle of ['capabilities.drop', 'allowPrivilegeEscalation', 'RuntimeDefault', '--cap-drop']) {
            expect(securityDocs, needle).toContain(needle);
        }
        expect(securityDocs).toContain('required by admission');
    });

    // The table is the part a reviewer reads instead of the section below it, so it has to carry
    // the one exception itself. An unqualified "with no switch to turn it off" over a row that a
    // declared service CAN turn off is the exact overstatement the opt-out subsection then
    // contradicts.
    it('qualifies the capability row in the control table rather than claiming it is unconditional', () => {
        const table = prose(securityDocs);
        expect(table).not.toContain('on every pod and every container, with no switch to turn it off');
        expect(table).toContain('| No capabilities | `capabilities.drop: [ALL]` unless `unhardened: true`');
        expect(table).toContain('`--cap-drop ALL` unless `unhardened: true` |');
    });

    it('states that the declared-service opt-out reaches the capabilities and nothing else', () => {
        expect(securityDocs).toContain('unhardened: true');
        expect(securityDocs).toContain('escalation bit stays off');
        // And the asymmetry: a gate image is hardened with NO escape hatch, which is a limit an
        // author hits as a failing gate rather than as a security message.
        expect(prose(securityDocs)).toContain('no opt-out for a GATE image');
    });

    // The workspace claim the issue is most explicit about: do NOT advertise task isolation.
    it('states that same-member tasks SHARE the workspace subtree', () => {
        expect(workspaceDocs).toContain('not a task boundary');
        expect(workspaceDocs).toContain('same member shares that subtree');
        // And that the narrower mount is a design, not a parameter — the issue's own instruction.
        expect(workspaceDocs).toContain('deliberately does not touch mount code');
    });

    it('states the deployment assumptions, each of which is silent when absent', () => {
        expect(kubernetesDocs).toContain('A CNI that enforces NetworkPolicy');
        expect(kubernetesDocs).toContain('ValidatingAdmissionPolicy, Kubernetes ≥ 1.30');
        expect(kubernetesDocs).toContain('httpPutResponseHopLimit');
        // The IP family: documented as a limit, since only IPv4 rules exist. The IPv4 rules still
        // cover IPv4 on a dual-stack cluster; what is missing there is the IPv6 half.
        expect(kubernetesDocs).toContain('IPv6 egress is not covered');
    });

    it('names each residual rather than leaving it to be discovered', () => {
        // The portless driver egress — the hole the port scoping did not close.
        expect(kubernetesDocs).toContain('reach the driver pod on any port');
        // The two issues that own what this change deliberately did not implement.
        expect(kubernetesDocs).toContain('#257');
        expect(kubernetesDocs).toContain('#296');
        // The blockedCidrs hole: a public apiserver or node address is not covered.
        expect(kubernetesDocs).toContain('PUBLIC is not covered');
        // The control a NetworkPolicy cannot be, stated where someone might assume otherwise.
        expect(kubernetesDocs).toContain('says nothing about HTTP routes');
    });

    // The AUTHOR-facing half. security.md and kubernetes.md are read by operators; the person who
    // writes `services:` reads jobs.md, and the default this change introduces is one that breaks
    // their stock postgres. Documenting the opt-out only where operators look would leave that to
    // be diagnosed from a crash loop.
    it('tells a .bellows.yaml author about the hardening and the opt-out', () => {
        expect(jobsDocs).toContain('unhardened: true');
        // The symptom they will actually see, named.
        expect(prose(jobsDocs)).toContain('chowns its data directory as root');
        // The reach of the opt-out, so it is not read as "turns the sandbox off".
        expect(prose(jobsDocs)).toContain('capability set and nothing else');
        // And its cost, so granting it fleet-wide is a choice rather than a default.
        expect(jobsDocs).toContain('CAP_NET_RAW');
    });

    it('records which test lane proves what, and that a non-enforcing CNI passes vacuously', () => {
        expect(testingDocs).toContain('vacuously');
        expect(testingDocs).toContain('--netpol');
        // The control that makes the lane evidence: EVERY denial target is proved reachable
        // before the policy lands, so an address nothing listens on cannot report a pass.
        expect(prose(testingDocs)).toContain('honest-probe control on every denial target');
        // And the one target that has no honest probe, named rather than quietly asserted.
        expect(prose(testingDocs)).toContain('169.254.169.254) is not probed');
        // The gaps no lane covers, listed rather than implied by their absence.
        expect(testingDocs).toContain('What no lane covers');
    });
});
