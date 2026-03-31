# Approvals And Guardrails

This document explains how OpenBox verdicts are enforced by the SDK and how guardrails behave in live runs.

## Verdicts

The SDK understands these primary verdicts:

| Verdict | Meaning | Runtime effect |
| --- | --- | --- |
| `allow` | continue normally | execution proceeds |
| `constrain` | continue with advisory constraints | execution proceeds and constraints remain available in the response |
| `require_approval` | human review required | execution suspends or polls for approval |
| `block` | operation must not continue | execution throws a stop-style error |
| `halt` | workflow or agent run must stop | execution throws a halt error |

Legacy action strings such as `continue`, `stop`, and `require-approval` are normalized into these verdicts.

## Enforcement Model

The SDK enforces verdicts at boundary events.

For governed activities:

1. `ActivityStarted` is evaluated first
2. input-side guardrail handling may apply
3. the underlying tool or step executes
4. `ActivityCompleted` is evaluated
5. output-side guardrail handling may apply
6. approval may be required on either side

For workflows and agents:

- `WorkflowStarted` can stop execution early
- `WorkflowCompleted` can still be evaluated for policy and telemetry
- `WorkflowFailed` records failure context

## Important Live-Run Behavior

In a standard OpenBox Core deployment, policy evaluates before guardrails for an event.

Operational consequence:

- if policy returns a non-`allow` verdict such as `require_approval`, `block`, or `halt`, guardrails for that event may not run
- if you are testing a guardrail live and it does not fire, inspect the policy verdict first

This is the most common reason a guardrail UI test passes while the live run still shows no guardrail result.

## Guardrail Input And Output Handling

OpenBox responses may contain `guardrails_result`.

The SDK uses it in two ways.

### Input Redaction

If the response for `ActivityStarted` includes:

- `guardrails_result.input_type = "activity_input"`
- `guardrails_result.redacted_input`

the SDK applies the redacted input before calling the underlying tool or step.

### Output Redaction

If the response for `ActivityCompleted` includes:

- `guardrails_result.input_type = "activity_output"`
- `guardrails_result.redacted_input`

the SDK applies that redacted output before returning it to the caller.

### Validation Failure

If `guardrails_result.validation_passed` is `false`, the SDK throws `GuardrailsValidationError`.

## Guardrail Field Selection Guidance

For live activity guardrails, match against `ActivityStarted` fields whenever possible.

Recommended field targets:

| Activity type | Field to check | Example use |
| --- | --- | --- |
| `writeFile` | `input.content` | banned content or PII in file contents |
| `writeFile` | `input.path` | path-based restrictions |
| `runCommand` | `input.command` | banned shell commands |

Important:

- agent prompts are emitted as `SignalReceived(user_input)`, not as `ActivityStarted`
- if your OpenBox deployment only evaluates guardrails on activity events, a `user_input` guardrail will not inspect agent prompts directly

## Human Approval Flow

The approval path depends on where execution is happening.

### Workflow-Backed Activity Execution

When a tool or step executes inside a workflow context and OpenBox returns `require_approval`:

- the SDK creates approval state
- the workflow suspends through Mastra suspend or resume behavior
- approval context is stored in the approval registry
- later resume paths emit `SignalReceived` and poll approval status

This is the preferred path for long-running human review.

### Non-Workflow Activity Execution

When there is no workflow suspend context available, the SDK polls approval inline.

Current inline polling characteristics:

- total timeout: 5 minutes
- initial poll interval: 2.5 seconds
- exponential backoff up to 15 seconds

If approval does not resolve in time, the SDK throws `ApprovalPendingError`.

## Approval Outcomes

While polling approval status:

- `allow` marks the activity approved and execution continues
- `block` or `halt` throws `ApprovalRejectedError`
- expired approval throws `ApprovalExpiredError`
- missing or temporary approval API failures retry with backoff until timeout

## Output-Time Approval

Approval is not limited to `ActivityStarted`.

If `ActivityCompleted` returns `require_approval`, the SDK can:

- suspend the workflow after execution and before returning output
- or poll inline when no workflow suspension context exists

This is useful when policy wants to review actual output, not just the requested action.

## Agents And Approval

Wrapped agents also participate in approval handling through their workflow-like lifecycle.

Because agent runs emit `user_input`, `resume`, and `agent_output`, approval state can be resumed consistently across retries or resume calls.

## Runtime Errors You Should Expect

| Error | Meaning |
| --- | --- |
| `GovernanceHaltError` | OpenBox returned a stop or halt verdict, or a fail-closed API failure was converted into a halt |
| `GuardrailsValidationError` | guardrail validation failed |
| `ApprovalPendingError` | approval is still pending or inline polling timed out |
| `ApprovalRejectedError` | approval explicitly rejected the activity |
| `ApprovalExpiredError` | approval expired before resolution |

## Production Recommendations

1. Keep approval policy focused on business boundary events.
2. Treat hook-triggered telemetry as internal by default.
3. When testing guardrails live, make sure policy returns `allow` for that event.
4. Use `ActivityStarted` field selectors for tool-input guardrails.
5. Do not rely on `SignalReceived(user_input)` guardrails unless your OpenBox deployment explicitly supports guardrails on signals.
