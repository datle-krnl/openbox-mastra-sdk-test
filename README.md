# OpenBox Mastra SDK

`@openbox-ai/openbox-mastra-sdk` adds OpenBox governance, approvals, guardrails, and OpenTelemetry-backed operational telemetry to Mastra applications.

Use it when you need to:

- evaluate tools, workflow steps, workflows, and agents against OpenBox policy
- enforce approval flows from OpenBox verdicts
- apply input and output guardrails
- attach HTTP, database, file, and traced-function telemetry to governed runs
- install the integration once and keep future Mastra registrations governed

## Requirements

- Node.js `>=24.10.0`
- `@mastra/core` `^1.8.0`
- an OpenBox Core deployment reachable from the Mastra runtime
- an ESM-capable runtime and build pipeline

## Installation

```bash
npm install @openbox-ai/openbox-mastra-sdk @mastra/core
```

Required environment variables:

```bash
export OPENBOX_URL="https://your-openbox-core.example"
export OPENBOX_API_KEY="obx_live_your_key"
```

Optional but commonly used:

```bash
export OPENBOX_GOVERNANCE_POLICY="fail_open"
export OPENBOX_DEBUG="false"
```

## Quick Start

```ts
import { Mastra } from "@mastra/core/mastra";
import {
  getOpenBoxRuntime,
  withOpenBox
} from "@openbox-ai/openbox-mastra-sdk";

const mastra = new Mastra({
  agents: {
    // your agents
  },
  tools: {
    // your tools
  },
  workflows: {
    // your workflows
  }
});

const governedMastra = await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});

process.on("SIGTERM", async () => {
  await getOpenBoxRuntime(governedMastra)?.shutdown();
});
```

`withOpenBox()` is the recommended production entrypoint. It:

1. parses and validates SDK configuration
2. validates the API key unless `validate: false` is set
3. creates the OpenBox client and span processor
4. installs process-wide telemetry
5. wraps existing Mastra tools, workflows, and agents
6. patches future `addTool()`, `addWorkflow()`, and `addAgent()` calls

## Runtime Model

The SDK emits three categories of OpenBox payloads:

- boundary workflow events: `WorkflowStarted`, `WorkflowCompleted`, `WorkflowFailed`
- boundary activity events: `ActivityStarted`, `ActivityCompleted`
- signal events: `SignalReceived` for workflow resume, agent `user_input`, agent `resume`, and agent `agent_output`

It also captures operational spans for:

- HTTP requests
- supported database libraries
- file operations when file instrumentation is enabled
- custom functions wrapped with `traced()`

Important production behavior:

- agent-only LLM activity is represented as telemetry spans, not as standalone business activities
- agent prompts are emitted as `SignalReceived(user_input)`, not as tool activities
- the SDK ignores its own OpenBox API URL during telemetry setup to avoid feedback loops

## Configuration Highlights

Most applications only need a small part of the config surface:

| Option | Default | Use it to |
| --- | --- | --- |
| `apiUrl` | required | point the SDK at OpenBox Core |
| `apiKey` | required | authenticate governance and approval calls |
| `validate` | `true` | fail fast on invalid credentials or insecure URL setup |
| `onApiError` | `"fail_open"` | decide whether OpenBox outages should halt execution |
| `hitlEnabled` | `true` | enable approval suspension or polling flows |
| `httpCapture` | `true` | attach text HTTP bodies and headers to governance-relevant telemetry |
| `instrumentDatabases` | `true` | capture supported database activity |
| `instrumentFileIo` | `false` | enable file operation telemetry when required |
| `sendStartEvent` | `true` | emit `WorkflowStarted` |
| `sendActivityStartEvent` | `true` | emit `ActivityStarted` |
| `skipActivityTypes` | `["send_governance_event"]` | suppress selected activity types entirely |
| `skipSignals` | empty | suppress selected signal names |
| `maxEvaluatePayloadBytes` | `256000` | cap payload size before compact fallback logic applies |

See [docs/configuration.md](./docs/configuration.md) for the complete surface.

## Production Guidance

- Keep `validate` enabled outside tests and local mocks.
- Use HTTPS for all non-localhost OpenBox endpoints.
- Decide explicitly between `fail_open` and `fail_closed` before deployment.
- Treat hook-triggered telemetry as internal operational data unless your policy intentionally governs it.
- Keep `instrumentFileIo` disabled until you have a concrete file-governance requirement.
- Initialize telemetry once per process and shut it down on process exit.

## Documentation

- [docs/README.md](./docs/README.md): documentation index and reading order
- [docs/installation.md](./docs/installation.md): installation, startup, and shutdown
- [docs/configuration.md](./docs/configuration.md): configuration surface, env vars, and defaults
- [docs/integration-patterns.md](./docs/integration-patterns.md): `withOpenBox()` and manual integration patterns
- [docs/architecture.md](./docs/architecture.md): runtime architecture and data flow
- [docs/event-model.md](./docs/event-model.md): event types, payload shape, signals, and activity semantics
- [docs/telemetry.md](./docs/telemetry.md): HTTP, database, file, and traced-function capture
- [docs/approvals-and-guardrails.md](./docs/approvals-and-guardrails.md): verdict enforcement, approvals, and guardrails
- [docs/security-and-privacy.md](./docs/security-and-privacy.md): transport, capture boundaries, and hardening guidance
- [docs/troubleshooting.md](./docs/troubleshooting.md): common failures and diagnostics
- [docs/api-reference.md](./docs/api-reference.md): public API summary

## Public API Summary

Top-level exports include:

- `withOpenBox()` and `getOpenBoxRuntime()`
- `wrapTool()`, `wrapWorkflow()`, and `wrapAgent()`
- `OpenBoxClient`
- `parseOpenBoxConfig()` and `initializeOpenBox()`
- `setupOpenBoxOpenTelemetry()` and `traced()`
- `OpenBoxSpanProcessor`
- verdict, guardrail, workflow event, and error types

See [docs/api-reference.md](./docs/api-reference.md) for the full reference.
