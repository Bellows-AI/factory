{{/*
The release-scoped name every object in the chart shares, so `helm uninstall` takes the whole
stack and nothing else's. Deterministic per release, so the dashboard and the driver can agree on
the service name and the PVC name without sharing values. Truncated to 52, not 63: the longest
suffix appended to it on a DNS-label-bound object is `-collector` (a Service name), and a
truncation applied before the suffix would let a long release name render an invalid one.
*/}}
{{- define "factory.fullname" -}}
{{- default (printf "%s-factory" .Release.Name) .Values.fullnameOverride | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{/*
What a selector matches on: name and instance only. Selectors are immutable, so nothing that can
change between chart versions (the chart version, the app version) may ever appear in one — each
template appends its own `app.kubernetes.io/component` line.
*/}}
{{- define "factory.selectorLabels" -}}
app.kubernetes.io/name: factory
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "factory.labels" -}}
{{ include "factory.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
An image reference from `{repository, tag}`, the tag defaulting to the chart's appVersion — so a
chart version names the exact build it deploys, and an upgrade to a new build changes the pod
spec and rolls the pods. Usage: include "factory.image" (list $ .Values.dashboard.image)
*/}}
{{- define "factory.image" -}}
{{- $root := index . 0 -}}
{{- $image := index . 1 -}}
{{- printf "%s:%s" $image.repository (default $root.Chart.AppVersion $image.tag) -}}
{{- end -}}

{{/*
The name of the Secret holding the dashboard's credentials — created by this chart unless
`secret.existingSecret` names one the operator manages instead.
*/}}
{{- define "factory.secretName" -}}
{{- default (printf "%s-dashboard" (include "factory.fullname" .)) .Values.secret.existingSecret -}}
{{- end -}}

{{/*
The name of the Secret the kubernetes executor reads runner credentials from, by RUNNER_ENV name.
The VALUES never travel — the pod spec carries `valueFrom.secretKeyRef`, which keeps the credential
out of every `kubectl get pods -o yaml` — so only this name is wired through.
*/}}
{{- define "factory.runnerSecretName" -}}
{{- default (printf "%s-runner-credentials" (include "factory.fullname" .)) .Values.runner.credentialsExistingSecret -}}
{{- end -}}

{{/* Whether the driver is handed a runner credentials Secret at all. */}}
{{- define "factory.runnerSecretEnabled" -}}
{{- if or .Values.runner.credentialsExistingSecret .Values.secret.create }}true{{ end -}}
{{- end -}}

{{/*
The workspaces claim. The dashboard writes checkouts into it and every runner mounts it — the
kubernetes form of the docker volume the two compose services share by name.
*/}}
{{- define "factory.workspaceClaim" -}}
{{- default (printf "%s-workspaces" (include "factory.fullname" .)) .Values.workspaces.existingClaim -}}
{{- end -}}

{{/*
A rolling restart whenever the chart-created Secret changes: env read by secretKeyRef is resolved
once, at container start, so without this a rotated credential waits for the next unrelated roll.
*/}}
{{- define "factory.secretChecksum" -}}
checksum/secret: {{ include (print .Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end -}}

{{/*
The scheduling and pull knobs every pod in the chart shares. The same `imagePullSecrets` are
forwarded to the runner pods the driver specs (RUNNER_IMAGE_PULL_SECRETS).
*/}}
{{- define "factory.podScheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
    - name: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
    {{- toYaml . | nindent 4 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
    {{- toYaml . | nindent 4 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
    {{- toYaml . | nindent 4 }}
{{- end }}
{{- end -}}

{{/*
Every container in the chart runs unprivileged on a read-only root: the writable paths are the
workspaces claim (dashboard) and an emptyDir at /tmp.
*/}}
{{- define "factory.containerSecurityContext" -}}
securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
        drop: ['ALL']
{{- end -}}
