{{/*
Names are the release name plus a fixed suffix, so the factory release's values can name them
without sharing values with this chart: `<release>-timescale` is the database service and
`<release>-workspaces` the claim.
*/}}
{{- define "state.labels" -}}
app.kubernetes.io/name: factory-local-state
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
