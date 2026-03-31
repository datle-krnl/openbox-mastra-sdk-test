# API Reference

This document summarizes the public API exported by `@openbox-ai/openbox-mastra-sdk`.

It is an integration-focused reference, not a generated type reference. Use it to decide which module to import from and which entrypoints the SDK expects you to use.

## Recommended Imports

Most applications should import from the package root:

```ts
import {
  getOpenBoxRuntime,
  withOpenBox
} from "@openbox-ai/openbox-mastra-sdk";
```

Use subpath imports only when you want to make module ownership explicit:

- `@openbox-ai/openbox-mastra-sdk/client`
- `@openbox-ai/openbox-mastra-sdk/config`
- `@openbox-ai/openbox-mastra-sdk/mastra`
- `@openbox-ai/openbox-mastra-sdk/otel`
- `@openbox-ai/openbox-mastra-sdk/span`
- `@openbox-ai/openbox-mastra-sdk/types`

The `./governance` subpath exists, but it does not currently expose a public API surface of its own.

## Root Export Families

The root module re-exports:

- client
- config
- mastra integration
- telemetry
- span processing
- public types

## Client Module

Import path:

```ts
import { OpenBoxClient } from "@openbox-ai/openbox-mastra-sdk";
```

### `type OpenBoxApiErrorPolicy`

```ts
type OpenBoxApiErrorPolicy = "fail_open" | "fail_closed";
```

Controls how API failures are treated.

### `interface OpenBoxClientOptions`

Key fields:

- `apiKey`
- `apiUrl`
- `evaluateMaxRetries`
- `evaluateRetryBaseDelayMs`
- `fetch`
- `onApiError`
- `timeoutSeconds`

### `class OpenBoxClient`

Main methods:

- `validateApiKey(): Promise<void>`
- `evaluate(payload): Promise<GovernanceVerdictResponse | null>`
- `pollApproval(payload): Promise<ApprovalPollResponse | null>`

Use this class when you need explicit control over transport, retries, or approval polling.

## Config Module

Import path:

```ts
import {
  API_KEY_PATTERN,
  getOpenBoxConfig,
  initializeOpenBox,
  parseOpenBoxConfig,
  setOpenBoxConfig,
  validateApiKeyFormat,
  validateUrlSecurity
} from "@openbox-ai/openbox-mastra-sdk";
```

### `interface OpenBoxConfigInput`

User-supplied config surface. See [configuration.md](./configuration.md) for the complete option table.

### `interface OpenBoxConfig`

Normalized runtime config with defaults applied and iterable fields converted to `Set<string>`.

### `parseOpenBoxConfig(input?, env?)`

Parses:

- explicit config options
- environment variables

Performs:

- required field checks
- API key format validation
- URL security validation
- default filling

### `initializeOpenBox(input?)`

Parses config and, if validation is enabled, validates the API key against OpenBox Core.

Use it when:

- you want config initialized before wiring wrappers
- you want startup validation separate from `withOpenBox()`

### `getOpenBoxConfig()` and `setOpenBoxConfig()`

Access or override the global config singleton.

Use sparingly. Prefer explicit runtime injection where practical.

## Mastra Module

Import path:

```ts
import {
  getOpenBoxRuntime,
  withOpenBox,
  wrapAgent,
  wrapTool,
  wrapWorkflow
} from "@openbox-ai/openbox-mastra-sdk";
```

### `interface WrapToolOptions`

Shared dependency bag used by wrappers:

- `client`
- `config`
- `spanProcessor`

### `wrapTool(tool, options)`

Wraps a Mastra tool in governed activity execution.

Typical effects:

- boundary activity events
- verdict enforcement
- guardrail handling
- approval handling
- telemetry association

### `wrapWorkflow(workflow, options)`

Wraps workflow lifecycle and non-tool workflow steps.

Typical effects:

- workflow start, completion, and failure events
- resume signal events
- governed step execution

### `wrapAgent(agent, options)`

Wraps agent lifecycle.

Typical effects:

- workflow-like lifecycle events for the agent run
- `user_input`, `resume`, and `agent_output` signals
- agent goal propagation
- agent-only LLM spans routed through signal telemetry

### `interface WithOpenBoxOptions`

Extends `OpenBoxConfigInput` and adds:

- `client`
- `dbLibraries`
- `fetch`
- `fileSkipPatterns`
- `ignoredUrls`
- `spanProcessor`

### `interface OpenBoxRuntime`

Runtime returned indirectly by `withOpenBox()` and accessible via `getOpenBoxRuntime()`.

Fields:

- `client`
- `config`
- `spanProcessor`
- `telemetry`
- `shutdown()`

### `withOpenBox(target, options?)`

Recommended zero-code integration.

Accepts:

- a Mastra instance
- an object containing `.mastra`

Creates runtime, patches Mastra, installs telemetry, and returns the same logical target.

### `getOpenBoxRuntime(target)`

Returns the installed runtime when available. Use it for:

- shutdown
- access to normalized config
- direct access to the client or span processor

## Telemetry Module

Import path:

```ts
import {
  setupOpenBoxOpenTelemetry,
  traced
} from "@openbox-ai/openbox-mastra-sdk";
```

### `interface OpenBoxTelemetryOptions`

Fields:

- `spanProcessor`
- `governanceClient`
- `captureHttpBodies`
- `dbLibraries`
- `fileSkipPatterns`
- `ignoredUrls`
- `instrumentDatabases`
- `instrumentFileIo`
- `onHookApiError`

### `interface OpenBoxTelemetryController`

Fields:

- `instrumentations`
- `tracerProvider`
- `shutdown()`

### `setupOpenBoxOpenTelemetry(options)`

Installs the SDK's process-wide telemetry layer.

Use it directly when:

- you are not using `withOpenBox()`
- you need explicit bootstrap order
- you only want telemetry without full Mastra patching

### `interface OpenBoxTracedOptions`

Fields:

- `captureArgs`
- `captureResult`
- `module`
- `name`
- `tracerName`

### `traced(fn, options?)`

Wraps an async function in a traced function span.

Use it for:

- custom operations outside standard tool or workflow boundaries
- explicitly named operational spans
- additional policy-relevant function telemetry

## Span Module

Import path:

```ts
import { OpenBoxSpanProcessor } from "@openbox-ai/openbox-mastra-sdk";
```

### `class OpenBoxSpanProcessor`

Implements the OpenTelemetry `SpanProcessor` interface and manages the SDK's enriched governance span buffer.

Typical usage:

- pass it to `setupOpenBoxOpenTelemetry()`
- reuse it across wrappers
- let `withOpenBox()` create it unless you need manual control

Exported companion types:

- `StoredSpanBody`
- `StoredTraceBody`
- `StoredWorkflowVerdict`
- `OpenBoxSpanData`
- `OpenBoxSpanProcessorOptions`
- `WorkflowSpanProcessor` as an alias of `OpenBoxSpanProcessor`

## Types Module

Import path:

```ts
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceAPIError,
  GovernanceVerdictResponse,
  GovernanceHaltError,
  GuardrailsCheckResult,
  GuardrailsValidationError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "@openbox-ai/openbox-mastra-sdk";
```

Use the exported types for:

- explicit error handling
- verdict inspection
- workflow event matching
- testing and integration typing
