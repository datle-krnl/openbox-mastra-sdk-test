# Security And Privacy

This SDK is designed for governance-sensitive workloads. The defaults are conservative where transport, capture, and failure behavior matter most.

## Transport Security

The SDK rejects insecure non-localhost OpenBox URLs.

Allowed:

- `https://openbox.example.com`
- `http://localhost:8086`
- `http://127.0.0.1:8086`
- `http://[::1]:8086`

Rejected:

- `http://openbox.example.com`

Reason:

- API keys must not be sent over plaintext HTTP outside local development

## API Key Validation

API keys must match:

- `obx_live_*`
- `obx_test_*`

When `validate` is `true`, startup also verifies the key against OpenBox Core using `/api/v1/auth/validate`.

Use `validate: false` only for:

- tests
- mock servers
- deliberately offline local development

## Capture Boundary

The SDK can capture request and response bodies for HTTP telemetry, but it does so inside its own runtime rather than exposing that data as ordinary OTel span attributes.

Key properties:

- HTTP bodies are not stored as ordinary OTel span attributes
- bodies and headers are buffered inside the SDK span processor
- the data is merged into governance payloads only when required

This reduces accidental leakage through generic tracing exporters.

## Default Capture Posture

| Setting | Default | Why |
| --- | --- | --- |
| `httpCapture` | `true` | useful governance and incident context |
| `instrumentDatabases` | `true` | low-friction visibility into data access |
| `instrumentFileIo` | `false` | file telemetry can be noisy and sensitive |

If your environment is highly sensitive:

- consider disabling `httpCapture`
- enable it selectively in lower environments first
- review OpenBox retention and policy posture before broad rollout

## Text-Only HTTP Body Capture

The SDK only treats text-like content as body-capturable text.

Examples:

- `text/*`
- `application/json`
- `application/xml`
- `application/javascript`
- `application/x-www-form-urlencoded`

This avoids nonsensical capture of binary payloads.

## File I/O Is Opt-In

File instrumentation is disabled by default.

When enabled, the SDK still skips common system and binary paths such as:

- `/dev/`
- `/proc/`
- `/sys/`
- `__pycache__`
- `.so`
- `.dylib`

Do not enable file telemetry broadly unless you have a concrete policy or audit requirement for it.

## Ignore Internal Service URLs

Always ignore service URLs that should not be governed.

Minimum recommendation:

- ignore your OpenBox Core URL

Why:

- prevents the SDK from tracing and governing its own API calls
- reduces noise
- avoids governance loops

`withOpenBox()` already adds `apiUrl` to the ignored URL set.

## API Failure Policy

`onApiError` controls what happens if OpenBox cannot be reached.

### `fail_open`

Use when:

- service availability is more important than strict governance enforcement
- governance outages must not stop production traffic

Tradeoff:

- requests can continue without a live governance decision

### `fail_closed`

Use when:

- governance enforcement is mandatory
- ungoverned execution is unacceptable

Tradeoff:

- OpenBox outages become execution blockers

## Payload Size And Data Minimization

The SDK limits large governance payloads through `maxEvaluatePayloadBytes`.

When agent completion payloads are too large:

- the SDK retries with a compact version
- then retries with an ultra-minimal version if needed

This keeps governance requests bounded without requiring unbounded payload growth.

## Debug Logging

`OPENBOX_DEBUG=true` enables summarized request and response logging.

It logs:

- event type
- activity and workflow identity
- presence of inputs, outputs, spans, and errors
- retry attempts
- verdict metadata summary

It does not try to print full raw governance payloads by default.

Recommendation:

- enable it in development, staging, and incident response
- keep it disabled by default in steady-state production unless your logging posture explicitly allows it

## Production Hardening Checklist

1. Use HTTPS for OpenBox Core.
2. Keep `validate` enabled in production.
3. Keep OpenBox Core ignored in telemetry capture.
4. Decide explicitly between `fail_open` and `fail_closed`.
5. Enable file I/O capture only if you need it.
6. Review policy so hook-triggered telemetry is not mistaken for a second user action.
7. Use OpenBox guardrails and retention controls for sensitive prompts or outputs.
