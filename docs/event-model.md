# Event Model

This SDK emits OpenBox governance events and hook-triggered telemetry payloads. Understanding that event model is necessary for:

- writing policy
- configuring guardrails
- reading the OpenBox UI correctly
- diagnosing duplicate approvals or missing telemetry

## Top-Level Event Types

| Event type | Emitted by | Primary use |
| --- | --- | --- |
| `WorkflowStarted` | wrapped workflows and agents | start-of-run governance |
| `WorkflowCompleted` | wrapped workflows and agents | final outcome, output, and summary telemetry |
| `WorkflowFailed` | wrapped workflows and agents | failure reporting |
| `SignalReceived` | workflow resume and agent lifecycle signals | resume handling and agent-specific payloads |
| `ActivityStarted` | wrapped tools and wrapped non-tool workflow steps | input-time governance and approvals |
| `ActivityCompleted` | wrapped tools and wrapped non-tool workflow steps | output-time governance and approvals |

All evaluate payloads also include:

- `source: "workflow-telemetry"`
- `timestamp`
- workflow identity
- run identity

## Business Activities Versus Internal Telemetry

In this SDK, a business activity is:

- a wrapped Mastra tool execution
- a wrapped non-tool workflow step execution

These are not separate business activities:

- internal HTTP hook telemetry
- internal DB query hook telemetry
- internal file operation hook telemetry
- internal traced-function hook telemetry
- agent-only LLM completions

Those are operational spans attached to a parent activity, signal, or workflow.

## Activity Type Normalization

The SDK normalizes activity names to camelCase before sending them to OpenBox.

Examples:

| Original identifier | Emitted `activity_type` |
| --- | --- |
| `writeFile` | `writeFile` |
| `Write File` | `writeFile` |
| `search_crypto_coins` | `searchCryptoCoins` |
| `Search crypto coins` | `searchCryptoCoins` |

Use the emitted form in:

- OpenBox policy
- guardrail activity filters
- `skipActivityTypes`
- UI filtering

## Workflow And Agent Identity

### Workflow Identity

Wrapped workflows use:

- `workflow_id = workflow.id`
- `workflow_type = workflow.id`

### Agent Identity

Wrapped agents use:

- `workflow_type = agent.id ?? agent.name ?? "agent"`
- `workflow_id = "agent:" + workflow_type`

This is why agent runs appear as workflow-like entities in OpenBox.

## Signals

Signals are used for workflow resumes and agent lifecycle events.

### Workflow Signals

`wrapWorkflow()` emits `SignalReceived` when a workflow resumes.

If the resume payload includes `label`, that becomes the signal name. Otherwise the signal name is `resume`.

### Agent Signals

`wrapAgent()` emits these signals:

| Signal name | When emitted | Purpose |
| --- | --- | --- |
| `user_input` | `generate()` or `stream()` start | carry the initiating prompt or request |
| `resume` | `resumeGenerate()` or `resumeStream()` | carry resume payload |
| `agent_output` | successful completion or failure finalization | carry agent output plus agent LLM spans |

Important:

- agent prompt input is emitted as a signal, not as `ActivityStarted`
- if your OpenBox deployment only runs guardrails on activity events, it will not inspect `user_input` directly

## Payload Shape Guidance

The SDK uses slightly different payload shapes depending on the event type and downstream compatibility requirements.

### `ActivityStarted`

For standard tool calls, `activity_input` is emitted in a guardrail-friendly shape. In practice, this means guardrail selectors should target the natural input object:

- `input.command` for `runCommand`
- `input.content` for `writeFile`
- `input.path` for file path checks

This is the recommended place to match tool inputs for policy and guardrails.

### `ActivityCompleted`

`ActivityCompleted` retains a compatibility-oriented input shape for downstream systems that still expect list-form activity input.

Operational guidance:

- use `activity_id` to correlate started and completed events
- if you write policy that inspects `activity_input` on both start and completed events, handle both object and list forms
- do not assume a guardrail selector that works for `ActivityStarted` will also be the right selector for `ActivityCompleted`

## Goal Propagation

When available, the SDK includes `goal` on agent-related payloads.

Goal resolution order:

1. `OPENBOX_AGENT_GOAL`
2. previously associated goal for the run
3. latest user prompt from the interaction payload
4. agent instructions

This is the main path by which goal-alignment and drift analysis receives agent goal context.

## Hook-Triggered Telemetry

Operational telemetry is sent through hook-triggered governance payloads.

Characteristics:

- `hook_trigger: true`
- `spans` contains normalized OpenBox span objects
- one hook event carries one started or completed span phase
- the span remains associated with its parent activity, signal, or workflow context

Supported hook span families:

- `http_request`
- `db_query`
- `file_operation`
- `function_call`

## Agent LLM Span Semantics

Agent-only LLM calls do not create standalone `agentLlmCompletion` business activities.

Current behavior:

- started and completed LLM spans are routed into the agent telemetry path
- they are surfaced on `SignalReceived` with `signal_name: "agent_output"`
- they may also contribute to `WorkflowCompleted` telemetry payloads

This keeps the activity list focused on business operations while preserving model telemetry.

## Typical Event Sequences

### Tool Or Step Sequence

```text
ActivityStarted
-> zero or more hook-triggered span payloads during execution
-> ActivityCompleted
```

### Agent Sequence

```text
WorkflowStarted
-> SignalReceived(user_input)
-> internal LLM and hook telemetry
-> SignalReceived(agent_output)
-> WorkflowCompleted
```

Resume-capable agent runs can also emit:

```text
SignalReceived(resume)
```

## Policy And Guardrail Guidance

Recommended policy stance:

- treat workflow and activity boundary events as governable business actions
- treat hook-triggered span payloads as internal telemetry unless you intentionally want to govern them directly
- use `ActivityStarted` when matching tool inputs for approvals or guardrails
- remember that agent prompts are signals, not activities

If hook-triggered payloads are governed like standalone business actions, you can create:

- duplicate approvals
- approval loops
- noisy activity listings
- harder-to-read operator timelines
