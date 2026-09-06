{{/*
The release-scoped name every object in the chart shares, so `helm uninstall` takes the whole
stack and nothing else's. Deterministic per release, so the dashboard and the driver can agree on
the service name and the PVC name without sharing values.
*/}}
{{- define "factory.fullname" -}}
{{- default (printf "%s-factory" .Release.Name) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "factory.labels" -}}
app.kubernetes.io/name: factory
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
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

{{/*
The workspaces claim. The dashboard writes checkouts into it and every runner mounts it — the
kubernetes form of the docker volume the two compose services share by name.
*/}}
{{- define "factory.workspaceClaim" -}}
{{- default (printf "%s-workspaces" (include "factory.fullname" .)) .Values.workspaces.existingClaim -}}
{{- end -}}

{{/*
Where the dashboard finds its database: the in-chart TimescaleDB service when it is enabled, the
operator's URL when it is not. The in-chart credentials default to compose's local ones, which are
not secrets the same way the App key is — the database is reachable only inside the cluster.
*/}}
{{- define "factory.databaseUrl" -}}
{{- if .Values.database.url -}}
{{- .Values.database.url -}}
{{- else if .Values.timescale.enabled -}}
{{- printf "postgres://%s:%s@%s-timescale:5432/%s" .Values.timescale.user .Values.timescale.password (include "factory.fullname" .) .Values.timescale.database -}}
{{- else -}}
{{- fail "database.url must be set when timescale.enabled is false" -}}
{{- end -}}
{{- end -}}
