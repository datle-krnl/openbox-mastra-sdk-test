# Telemetry

This SDK uses OpenTelemetry internally, but it does not simply forward raw spans to OpenBox. It captures, buffers, enriches, and normalizes telemetry into governance-ready payloads.

## What The SDK Captures

### HTTP

Enabled by default through `httpCapture: true`.

The SDK installs:

- Node HTTP instrumentation
- Undici instrumentation
- fetch patching for request and response body capture

This covers:

- `fetch`
- Node `http` and `https`
- Undici-based clients

Captured fields can include:

- method
- URL
- request headers
- response headers
- request body
- response body
- status code

Only text-like content types are treated as body-capturable text. Binary payloads are not captured as text.

### Databases

Enabled by default through `instrumentDatabases: true`.

Supported selectors:

- `pg`
- `postgres`
- `mysql`
- `mysql2`
- `mongodb`
- `mongoose`
- `redis`
- `ioredis`
- `knex`
- `oracledb`
- `cassandra`
- `tedious`

If `dbLibraries` is omitted, the SDK enables every supported DB instrumentation it can resolve.

### File I/O

Disabled by default through `instrumentFileIo: false`.

When enabled, the SDK can emit spans for file operations such as:

- open
- read
- write
- readline
- readlines
- writelines
- close

Built-in skip patterns include:

- `/dev/`
- `/proc/`
- `/sys/`
- `\\?\pipe\`
- `__pycache__`
- `.pyc`
- `.pyo`
- `.so`
- `.dylib`

Override them with `fileSkipPatterns` when you install telemetry manually.

### Traced Functions

You can create explicit function spans with `traced()`:

```ts
import { traced } from "@openbox-ai/openbox-mastra-sdk";

const summarize = traced(
  async function summarize(text: string) {
    return text.slice(0, 120);
  },
  {
    captureArgs: true,
    captureResult: true,
    module: "summary"
  }
);
```

Supported options:

- `captureArgs`
- `captureResult`
- `module`
- `name`
- `tracerName`

## How Telemetry Reaches OpenBox

The SDK has two telemetry paths:

1. buffered spans attached to later workflow, activity, or signal payloads
2. hook-triggered governance payloads sent during execution

Hook-triggered payloads are used for internal operational spans such as HTTP, DB, file, and traced-function activity.

## Hook Payload Characteristics

Hook payloads:

- include `hook_trigger: true`
- include normalized OpenBox spans under `spans`
- carry one started or completed span phase per hook event
- attach to an existing parent workflow, activity, or agent context

For agent-only LLM traffic with no separate business activity parent:

- spans are queued
- they are later emitted on `SignalReceived(agent_output)`

## Privacy Boundary

Bodies and headers are not stored as ordinary OTel span attributes. Instead:

1. the SDK captures them into its internal span processor
2. the SDK merges them into governance payloads when required
3. generic OTel exporters are not relied on to carry those bodies

This keeps OpenBox-specific governance context separate from generic tracing infrastructure.

## Ignored URLs

Always ignore URLs that should not be governed. At minimum, ignore your OpenBox Core URL.

`withOpenBox()` already does this automatically by adding `apiUrl` to the ignored URL set.

If you install telemetry manually, do the same:

```ts
const telemetry = setupOpenBoxOpenTelemetry({
  governanceClient: client,
  ignoredUrls: [config.apiUrl],
  spanProcessor
});
```

## Payload Budgeting

Agent `WorkflowCompleted` payloads can grow large because they may include:

- workflow output
- model metadata
- usage metrics
- buffered spans

The SDK handles this by attempting progressively smaller payloads:

1. full payload
2. compact payload
3. ultra-minimal payload

The threshold is controlled by `maxEvaluatePayloadBytes`.

## Operational Recommendations

- Keep `httpCapture` enabled unless payload sensitivity or volume makes that unacceptable.
- Keep `instrumentDatabases` enabled in most environments.
- Enable `instrumentFileIo` only when you need file-governance visibility.
- Keep `ignoredUrls` aligned with internal service endpoints that should not be governed.
- Do not initialize telemetry twice in the same process unless you intentionally want to replace the active controller.

## Common Policy Interaction

If policy treats hook-triggered telemetry as a second user action, you can see:

- duplicate approvals
- noisy `http_request`, `db_query`, `file_operation`, or `function_call` rows
- approval loops while a parent activity is already pending approval

Recommended policy behavior:

- govern workflow and activity boundary events
- treat hook-triggered payloads as internal telemetry unless you have a specific reason to gate them directly
