# OpenBox Mastra SDK Documentation

This directory contains the production documentation for `@openbox-ai/openbox-mastra-sdk`.

The SDK has three responsibilities:

1. wrap Mastra tools, workflows, and agents with OpenBox governance
2. capture operational telemetry with OpenTelemetry
3. translate OpenBox verdicts into runtime behavior such as continue, block, redact, or require approval

## Recommended Reading Order

If you are integrating the SDK into a new service, read in this order:

1. [installation.md](./installation.md)
2. [configuration.md](./configuration.md)
3. [integration-patterns.md](./integration-patterns.md)
4. [event-model.md](./event-model.md)
5. [approvals-and-guardrails.md](./approvals-and-guardrails.md)
6. [telemetry.md](./telemetry.md)
7. [security-and-privacy.md](./security-and-privacy.md)
8. [troubleshooting.md](./troubleshooting.md)
9. [api-reference.md](./api-reference.md)

## Document Map

| Document | Use it for |
| --- | --- |
| [installation.md](./installation.md) | installation, required runtime conditions, first startup, and shutdown |
| [configuration.md](./configuration.md) | runtime options, environment variables, parsing rules, and defaults |
| [integration-patterns.md](./integration-patterns.md) | choosing between `withOpenBox()`, manual wrappers, and telemetry-only setup |
| [architecture.md](./architecture.md) | understanding the runtime model and operational data flow |
| [event-model.md](./event-model.md) | policy authoring, UI expectations, signal handling, and payload shape |
| [telemetry.md](./telemetry.md) | capture surfaces, defaults, and operational telemetry behavior |
| [approvals-and-guardrails.md](./approvals-and-guardrails.md) | verdict enforcement, approval flows, and live guardrail behavior |
| [security-and-privacy.md](./security-and-privacy.md) | transport, capture boundaries, and production hardening |
| [troubleshooting.md](./troubleshooting.md) | diagnosing startup, policy, telemetry, approval, and guardrail issues |
| [api-reference.md](./api-reference.md) | public API surface and recommended imports |

## Support Matrix

| Dependency | Requirement |
| --- | --- |
| Node.js | `>=24.10.0` |
| Mastra | `@mastra/core ^1.8.0` |
| Module format | ESM |
| OpenBox Core | reachable over HTTPS except localhost development |

## Core Terms

| Term | Meaning |
| --- | --- |
| Workflow boundary event | `WorkflowStarted`, `WorkflowCompleted`, or `WorkflowFailed` |
| Activity boundary event | `ActivityStarted` or `ActivityCompleted` for tools and non-tool workflow steps |
| Signal event | `SignalReceived` emitted for workflow resume and agent lifecycle signals |
| Hook telemetry | internal span-derived governance payload carrying operational data such as HTTP or DB work |
| Governed activity | a tool execution or non-tool workflow step evaluated against OpenBox |
| Agent output signal | `SignalReceived` with `signal_name: "agent_output"` carrying agent output and agent LLM spans |

## Choosing An Integration Strategy

Use [integration-patterns.md](./integration-patterns.md) to choose between:

- `withOpenBox()` for standard application bootstrap
- manual wrappers for selective adoption
- telemetry-only setup when you need tracing without full Mastra patching
