# Troubleshooting

This document covers the most common integration, policy, approval, and guardrail issues seen with the Mastra SDK.

## Startup Fails With Configuration Error

Symptoms:

- `OpenBoxConfigError`
- `OpenBoxAuthError`
- `OpenBoxInsecureURLError`

Checks:

1. Verify `OPENBOX_URL` is set.
2. Verify `OPENBOX_API_KEY` is set.
3. Verify the API key matches `obx_live_*` or `obx_test_*`.
4. Verify non-localhost URLs use HTTPS.
5. If using a mock server, set `validate: false`.

## No Events Show Up In OpenBox

Checks:

1. Confirm your process is using the governed Mastra instance returned by `withOpenBox()`.
2. Confirm the first operation is actually wrapped.
3. Enable `OPENBOX_DEBUG=true`.
4. Confirm the OpenBox API URL is reachable from the runtime.
5. If consuming the SDK from a local path, confirm the consuming app is loading the rebuilt package output.

If you are consuming this repo locally:

```bash
npm run build
```

Then restart the consuming application.

## Guardrail UI Test Passes But The Live Run Does Not Fire

Most common cause:

- policy returned a non-`allow` verdict first, so guardrails for that event did not run

What to check:

1. inspect `evaluate.response` for the activity's `ActivityStarted` event
2. if the verdict is `require_approval`, `block`, or `halt`, policy won before guardrails
3. adjust policy so the tested event returns `allow` if you want to validate guardrail behavior live

## Guardrail On Agent Prompt Does Not Fire

Reason:

- agent prompt input is emitted as `SignalReceived(user_input)`, not as `ActivityStarted`

Operational implication:

- OpenBox deployments that only evaluate guardrails on activity events will not inspect the raw agent prompt directly

Use a downstream activity guardrail instead, or add signal-aware guardrail support in the downstream OpenBox deployment.

## `runCommand` Or `writeFile` Guardrail Field Does Not Match

For current SDK versions, tool input on `ActivityStarted` is emitted in a guardrail-friendly object shape.

Use:

- `input.command` for `runCommand`
- `input.content` for `writeFile`
- `input.path` for file path checks

If you are still trying selectors such as `input[0].command`, you are likely testing against an older payload assumption.

## Custom Policy Breaks After SDK Upgrade

If you have custom OPA or downstream logic that assumes `activity_input[0]` everywhere, update it.

Current guidance:

- handle object-shaped `activity_input` on `ActivityStarted`
- handle compatibility-oriented list-shaped `activity_input` on `ActivityCompleted`

Use `activity_id` for start and completion correlation.

## Duplicate Approval Requests

Most common cause:

- policy is treating hook-triggered internal telemetry as a governable activity in addition to the real boundary activity

What to check:

- payloads with `hook_trigger: true`
- hook span content under `spans`
- `activity_type` values such as `http_request`, `db_query`, `file_operation`, or `function_call`

Recommended fix:

- require approval on business boundary events
- exclude internal hook-triggered telemetry from approval policy unless you intentionally want to govern it

## `http_request` Shows Up As A Separate Activity Row

This usually means policy or UI interpretation is treating hook-triggered telemetry like a business activity.

Recommended interpretation:

- tools and non-tool steps are business activities
- `http_request` hook payloads are internal operational telemetry

## Agent LLM Spans Are Missing

Checks:

1. Make sure `skipSignals` does not include `agent_output`.
2. Confirm the agent is wrapped with `withOpenBox()` or `wrapAgent()`.
3. Enable `OPENBOX_DEBUG=true` and verify `SignalReceived` with `signal_name: "agent_output"`.
4. If consuming the SDK locally, rebuild `dist/` and restart the app.

Important behavior:

- agent-only LLM completions are emitted as spans on `agent_output`
- they are not intended to appear as standalone `agentLlmCompletion` activities

## Started Or Completed Spans Are Missing

Checks:

1. Confirm telemetry is installed only once and not being replaced unintentionally.
2. Confirm the relevant instrumentation is enabled.
3. Confirm the operation is not excluded by ignored URLs or file skip patterns.
4. Confirm you are looking at the correct parent activity or signal in OpenBox.

For agent LLM activity, inspect `SignalReceived(agent_output)`.

## OpenBox API Failures Cause Unexpected Continuation Or Stoppage

Check `onApiError` or `OPENBOX_GOVERNANCE_POLICY`.

Expected behavior:

- `fail_open`: execution usually continues after retries are exhausted
- `fail_closed`: execution halts after retries are exhausted

If runtime behavior differs from expectations, verify:

- the value is what you think at startup
- you are not mixing explicit code config with environment variables unexpectedly

## Approval Never Resolves

Checks:

1. Verify OpenBox approval responses eventually return `allow`, `block`, or `halt`.
2. Verify approval request keys match `workflow_id`, `run_id`, and `activity_id`.
3. Verify you are resuming the correct workflow step or agent run.
4. Check whether approval expired before it was answered.

For inline approval paths, remember:

- the SDK polls with bounded backoff
- if approval does not resolve in time, `ApprovalPendingError` is raised

## Local Code Changes Are Not Reflected In My App

If you are consuming this repo locally, source changes are not enough. The consuming app needs the rebuilt package output.

Run:

```bash
npm run build
```

Then restart the consuming process.

If the consuming app uses a copied tarball or cached install, refresh that dependency path too.

## I Initialized Telemetry Twice

Symptoms:

- spans disappear unexpectedly
- instrumentation behaves inconsistently
- a previously working runtime stops capturing

Reason:

- `setupOpenBoxOpenTelemetry()` owns one active controller at a time
- a new initialization tears down the previous active controller

Fix:

- initialize telemetry once during process bootstrap
- share the resulting runtime across all wrappers in that process

## Useful Debug Mode

Set:

```bash
export OPENBOX_DEBUG=true
```

This enables summarized logs for:

- evaluate requests
- evaluate retries
- approval polling
- response summaries including verdict metadata when present
