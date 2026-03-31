# Architecture

This document explains how the SDK is structured so you can reason about deployment behavior, ownership, and operational tradeoffs.

## Design Goals

The SDK is built around four goals:

1. keep governance decisions at clear business boundaries
2. attach operational telemetry to those boundaries without building a custom tracing layer
3. preserve approval state across workflow and agent resume paths
4. make the default integration path safe enough for production bootstrap

## High-Level Layout

```text
Mastra application
|- tools
|- workflows
`- agents
    |
    v
OpenBox Mastra SDK
|- Mastra wrappers
|  |- wrapTool()
|  |- wrapWorkflow()
|  |- wrapAgent()
|  `- withOpenBox()
|- Governance runtime
|  |- OpenBoxClient
|  |- config parsing
|  `- approval registry
|- Telemetry runtime
|  |- OpenBoxSpanProcessor
|  |- OpenTelemetry instrumentation
|  `- hook-governance bridge
`- Public type surface
    |- verdicts
    |- guardrails
    |- workflow events
    `- runtime errors
    |
    v
OpenBox Core
|- /api/v1/auth/validate
|- /api/v1/governance/evaluate
`- /api/v1/governance/approval
```

## Main Runtime Components

### `withOpenBox()`

Responsibilities:

- create the OpenBox runtime
- install process-wide telemetry
- patch current and future Mastra registries
- expose a runtime handle for shutdown and diagnostics

Operational implication:

- one governed Mastra process should normally have one active OpenBox runtime

### `OpenBoxClient`

Responsibilities:

- validate the API key
- send evaluate requests
- poll approval status
- apply retry and timeout policy
- summarize debug logging when `OPENBOX_DEBUG=true`

Operational implication:

- API failure behavior is controlled centrally through `onApiError`

### `OpenBoxSpanProcessor`

Responsibilities:

- buffer spans by workflow and run
- associate child telemetry with parent activity or workflow context
- hold captured HTTP bodies and headers until governance payload assembly
- queue agent-only LLM telemetry until the `agent_output` signal is emitted

Operational implication:

- telemetry is enriched inside the SDK before it becomes an OpenBox governance payload

### Approval Registry

Responsibilities:

- track approval state across resume paths
- keep workflow-backed approval flows coherent
- prevent approval handling from being tied only to a single stack frame

Operational implication:

- approval state is runtime control data, not a persistence layer

## Boundary And Telemetry Model

The SDK distinguishes between two kinds of data:

- business boundary events such as `ActivityStarted`, `ActivityCompleted`, and workflow lifecycle events
- internal operational telemetry such as HTTP, database, file, and traced-function spans

This distinction matters because:

- policy is usually easiest to reason about at business boundaries
- hook-triggered telemetry can be noisy if treated as a second user action
- approvals become harder to operate if both layers are governed the same way

## Execution Flows

### Tool Or Step Execution

```text
boundary starts
-> ActivityStarted
-> verdict and guardrail handling
-> underlying execution
-> telemetry capture during execution
-> ActivityCompleted
-> output verdict and guardrail handling
-> return or suspend
```

### Workflow Execution

```text
workflow starts
-> WorkflowStarted
-> governed steps run
-> optional SignalReceived on resume
-> WorkflowCompleted or WorkflowFailed
```

### Agent Execution

```text
agent run starts
-> WorkflowStarted
-> SignalReceived(user_input)
-> underlying agent execution
-> agent LLM and hook telemetry captured
-> SignalReceived(agent_output)
-> WorkflowCompleted or WorkflowFailed
```

## Why Signals Matter

Signals are not just a workflow resume mechanism in this SDK. They also carry agent-specific lifecycle state.

Production implications:

- agent prompt input is emitted as `SignalReceived(user_input)`
- agent output and agent-only LLM spans are emitted through `SignalReceived(agent_output)`
- if you suppress or ignore those signals, you lose the main observability path for agent-level prompt and completion context

## Telemetry Ownership

`setupOpenBoxOpenTelemetry()` manages one active telemetry controller per process.

Operational implications:

- initializing telemetry twice replaces the previous controller
- shutdown should happen during process termination
- the OpenBox API URL should be ignored to avoid tracing and governing the SDK's own API traffic

## Failure Model

The SDK treats these as distinct classes of failure:

- OpenBox API failure
- governance stop or halt verdict
- approval pending, rejected, or expired
- guardrail validation failure
- underlying tool, workflow, or agent failure

Those differences are preserved in the surfaced runtime errors so application code can respond intentionally.

See [approvals-and-guardrails.md](./approvals-and-guardrails.md) for enforcement details and [troubleshooting.md](./troubleshooting.md) for common failure modes.
