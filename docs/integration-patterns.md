# Integration Patterns

This SDK supports three integration patterns:

1. `withOpenBox()` for standard application bootstrap
2. manual wrapping with `wrapTool()`, `wrapWorkflow()`, and `wrapAgent()`
3. telemetry-only setup with `setupOpenBoxOpenTelemetry()` and optional `traced()`

## Choose The Right Pattern

| Pattern | Use it when |
| --- | --- |
| `withOpenBox()` | you want one production runtime to govern the whole Mastra instance |
| manual wrappers | you need explicit startup order or selective adoption |
| telemetry-only | you want OpenBox span capture without full Mastra wrapping |

## `withOpenBox()`

`withOpenBox()` is the recommended integration path for most applications.

```ts
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

const governedMastra = await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});
```

What it does:

- parses and validates configuration
- creates an `OpenBoxClient`
- creates an `OpenBoxSpanProcessor`
- installs process-wide telemetry
- wraps current top-level tools, workflows, and agents
- patches future `addTool()`, `addWorkflow()`, and `addAgent()` calls
- hydrates agent-local tool and workflow registries where Mastra exposes them

### Idempotency

Calling `withOpenBox()` again on the same Mastra instance reuses the existing runtime instead of creating a second one.

### Accepted Targets

`withOpenBox()` accepts either:

- a Mastra instance
- an object with a `.mastra` property

Example:

```ts
await withOpenBox({ mastra }, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});
```

## Manual Wrapping

Use manual wiring when you need to control bootstrap order or govern only a subset of components.

```ts
import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
  wrapAgent,
  wrapTool,
  wrapWorkflow
} from "@openbox-ai/openbox-mastra-sdk";

const config = parseOpenBoxConfig({
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});

const client = new OpenBoxClient({
  apiKey: config.apiKey,
  apiUrl: config.apiUrl,
  evaluateMaxRetries: config.evaluateMaxRetries,
  evaluateRetryBaseDelayMs: config.evaluateRetryBaseDelayMs,
  onApiError: config.onApiError,
  timeoutSeconds: config.governanceTimeout
});

const spanProcessor = new OpenBoxSpanProcessor({
  ignoredUrlPrefixes: [config.apiUrl]
});

const telemetry = setupOpenBoxOpenTelemetry({
  captureHttpBodies: config.httpCapture,
  governanceClient: client,
  ignoredUrls: [config.apiUrl],
  instrumentDatabases: config.instrumentDatabases,
  instrumentFileIo: config.instrumentFileIo,
  spanProcessor
});

const governedTool = wrapTool(tool, {
  client,
  config,
  spanProcessor
});

const governedWorkflow = wrapWorkflow(workflow, {
  client,
  config,
  spanProcessor
});

const governedAgent = wrapAgent(agent, {
  client,
  config,
  spanProcessor
});

await telemetry.shutdown();
```

Use this pattern when:

- another subsystem owns telemetry bootstrap order
- you only want to govern selected tools, workflows, or agents
- you need a custom `OpenBoxClient` or `OpenBoxSpanProcessor`

## Telemetry-Only Setup

If you want telemetry capture without automatic Mastra patching, install the telemetry layer directly:

```ts
import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  traced
} from "@openbox-ai/openbox-mastra-sdk";

const client = new OpenBoxClient({
  apiKey: process.env.OPENBOX_API_KEY!,
  apiUrl: process.env.OPENBOX_URL!
});

const spanProcessor = new OpenBoxSpanProcessor({
  ignoredUrlPrefixes: [process.env.OPENBOX_URL!]
});

const telemetry = setupOpenBoxOpenTelemetry({
  governanceClient: client,
  ignoredUrls: [process.env.OPENBOX_URL!],
  spanProcessor
});

const governedFn = traced(
  async function sendEmail(input: { to: string }) {
    return { delivered: true, to: input.to };
  },
  {
    captureArgs: true,
    captureResult: true,
    module: "email"
  }
);

await telemetry.shutdown();
```

This pattern is useful when:

- orchestration is not fully Mastra-managed
- you want function-level tracing without wrapping all Mastra boundaries
- you intend to emit lifecycle events yourself

## Wrapper Behavior Summary

### `wrapTool()`

`wrapTool()` adds:

- `ActivityStarted` and `ActivityCompleted`
- verdict enforcement
- guardrail input and output handling
- approval suspension or polling
- telemetry association for work performed during the tool call

### `wrapWorkflow()`

`wrapWorkflow()` adds:

- `WorkflowStarted`, `WorkflowCompleted`, and `WorkflowFailed`
- `SignalReceived` on resume
- governed execution for non-tool workflow steps

Tool component steps are intentionally not double-wrapped.

### `wrapAgent()`

`wrapAgent()` models an agent run as a workflow-like unit and adds:

- workflow lifecycle events for the agent run
- `SignalReceived` for `user_input`, `resume`, and `agent_output`
- agent goal propagation
- agent-only LLM spans routed through `agent_output`

## Bootstrap Guidance

For production services:

1. initialize the SDK once during process startup
2. keep a reference to the governed Mastra instance or runtime
3. shut telemetry down during process termination
4. avoid calling `setupOpenBoxOpenTelemetry()` multiple times in the same process unless you intentionally want to replace the active controller
