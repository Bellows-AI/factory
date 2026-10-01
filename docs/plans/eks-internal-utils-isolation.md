# Runner isolation on a shared EKS cluster — what internal-utils does not enforce

Written during the first cloud install of `v0.0.0` (2026-10-01, EKS `internal-utils`,
eu-central-1, account 311772925847, Kubernetes v1.34). That install is a **disposable shakedown**:
it proves the chart renders and runs on a real cloud cluster, and it is torn down after. It is
**not** a cluster anyone should queue untrusted agent work against, and this file is the reason.

The runbook ([docs/eks-runbook.md](../eks-runbook.md), steps 1 and 6) states the two platform
settings the chart cannot make for itself. Both are observations, measured on this cluster, and
both came back wrong.

## 1. NetworkPolicy is admitted and not enforced

`charts/factory/templates/runner-networkpolicy.yaml` renders under `isolation.networkPolicy: true`
and the API server accepts it. The VPC CNI does not act on it:

```
$ kubectl get ds aws-node -n kube-system -o json | jq '.spec.template.spec.containers[1].args'
[
  "--enable-ipv6=false",
  "--enable-network-policy=false",     # <- here
  ...
]
```

`amazon-k8s-cni:v1.20.4-eksbuild.1`, `aws-network-policy-agent:v1.2.7-eksbuild.1`,
`NETWORK_POLICY_ENFORCING_MODE=standard` on `aws-node` — the mode is set, the agent is off. A
policy object exists, `kubectl describe` reads correctly, and no packet is ever dropped. This is
the worst of the three possible states: the cluster reports the isolation the chart asked for and
provides none of it.

Consequence for a runner pod: full egress to `isolation.blockedCidrs` — `10.0.0.0/8` is this
cluster's own VPC, which holds argocd, the `stage` and `development` namespaces, the monitoring
stack and ten `pr-*` preview namespaces. Agent-written code could reach every one of them.

**The fix is cluster-wide, which is why it is a follow-up and not a step of the install.**
Flipping `--enable-network-policy=true` starts enforcing *every* NetworkPolicy object on
internal-utils, not just this chart's. Any namespace carrying a policy that has been inert since
it was written would begin dropping traffic at that moment. Before flipping it:

1. Inventory every NetworkPolicy on the cluster and decide, per object, whether enforcing it is
   what its author meant.
2. Flip it in a maintenance window, not alongside an app install.
3. Re-run the runbook's step 6 observation from inside a runner pod: no egress to
   `169.254.169.254`, no egress to the private ranges, DNS only through kube-dns, and the
   dashboard, collector and driver reachable by podSelector.

Until then, a factory install on this cluster must either set `isolation.networkPolicy: false` —
honest, the chart stops claiming what the platform will not do — or carry this file as the reason
it lies. The shakedown install keeps the default (`true`) so the rendered object is exercised; the
dishonesty is bounded by the teardown.

## 2. IMDS hop limit is 2 on the managed node group

The runbook wants `httpPutResponseHopLimit: 1` on anything running runners, so a pod cannot reach
the node's instance metadata and assume the node role. Measured:

| Node source | `httpPutResponseHopLimit` | `httpTokens` |
| --- | --- | --- |
| Karpenter `default` EC2NodeClass | **1** | required |
| EKS managed node group `aws_managed-2025041413…` | **2** | required |

Karpenter is already correct. The managed group is not, and with NetworkPolicy inert there is no
second layer: a runner scheduled onto a managed-group node can read
`http://169.254.169.254/latest/meta-data/iam/security-credentials/` and get the node role.

Two ways out, and the first is the runbook's actual answer:

- **A dedicated runner node group**, tainted, hop limit 1, nothing else scheduled onto it, selected
  by `runner.nodeSelector` / `runner.tolerations`. This is what the runbook's step 1 asks for and
  what issue #361 argues. It also keeps agent-written code off the node holding the dashboard pod
  and its App key — a separate property that NetworkPolicy would not give back.
- Or set the managed group's hop limit to 1, which fixes the metadata reach and none of the
  co-tenancy.

The shakedown install sets neither: it runs no real executor, and there is no GitHub App on it, so
no agent code runs at all. The moment one does, the node group is a prerequisite, not a follow-up.

## 3. What the shakedown therefore proves, and what it does not

Proves: the chart renders against a real cloud cluster; the images pull from `ghcr.io/bellows-ai`
under `global.imageRegistry`; the EFS `ReadWriteMany` claim binds and the dashboard writes it as
uid 1000; the `pg_isready` init container gates on a real database; the ALB provisions, redirects
to https and passes `/api/health`.

Does not prove — and must not be reported as proven — anything in the runbook's steps 1 and 6:
NetworkPolicy enforcement, IMDS confinement, runner node isolation, or a job end to end. Those stay
open, and the runbook's "Walk record" should say so when this walk is folded back into epic #365.
