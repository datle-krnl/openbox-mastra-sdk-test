import { randomUUID } from "node:crypto";

import { trace } from "@opentelemetry/api";
import type { ToolExecutionContext } from "@mastra/core/tools";

import type { OpenBoxClient } from "../client/index.js";
import type { OpenBoxConfig } from "../config/index.js";
import type { OpenBoxSpanProcessor } from "../span/index.js";
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceVerdictResponse,
  GovernanceHaltError,
  GuardrailsValidationError,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "../types/index.js";
import {
  getOpenBoxExecutionContext,
  runWithOpenBoxExecutionContext
} from "./context.js";
import {
  clearActivityApproval,
  clearPendingApproval,
  isActivityApproved,
  markActivityApproved,
  setPendingApproval
} from "./approval-registry.js";

export interface WorkflowSuspendContext {
  runId: string;
  setState: (state: unknown) => void | Promise<void>;
  state: unknown;
  suspend: (
    payload: unknown,
    options?: Record<string, unknown>
  ) => unknown | Promise<unknown>;
  workflowId: string;
}

export interface ToolExecutionContextLike {
  agent?: ToolExecutionContext["agent"];
  requestContext?: ToolExecutionContext["requestContext"];
  workflow?: WorkflowSuspendContext | undefined;
}

export interface ActivityRuntimeDependencies {
  client: OpenBoxClient;
  config: OpenBoxConfig;
  spanProcessor: OpenBoxSpanProcessor;
}

export interface GovernedActivityOptions<TInput, TOutput> {
  dependencies: ActivityRuntimeDependencies;
  execute: (input: TInput) => Promise<TOutput>;
  input: TInput;
  runtimeContext: ToolExecutionContextLike;
  type: string;
}

export async function executeGovernedActivity<TInput, TOutput>({
  dependencies,
  execute,
  input,
  runtimeContext,
  type
}: GovernedActivityOptions<TInput, TOutput>): Promise<TOutput | undefined> {
  const descriptor = resolveActivityDescriptor(type, runtimeContext);
  const startedInputForEvent = appendGoalToActivityInput(
    serializeActivityInputForStartEvent(input),
    descriptor.goal
  );
  let inputForExecution = cloneValue(input);

  ensureSpanBuffer(descriptor, dependencies.spanProcessor);
  dependencies.spanProcessor.clearActivityAbort(
    descriptor.workflowId,
    descriptor.activityId
  );
  dependencies.spanProcessor.clearHaltRequested(
    descriptor.workflowId,
    descriptor.activityId
  );
  dependencies.spanProcessor.setActivityContext(
    descriptor.workflowId,
    descriptor.activityId,
    {
      activity_id: descriptor.activityId,
      activity_input: startedInputForEvent,
      activity_type: descriptor.activityType,
      attempt: descriptor.attempt,
      ...(descriptor.goal ? { goal: descriptor.goal } : {}),
      run_id: descriptor.runId,
      task_queue: descriptor.taskQueue,
      workflow_id: descriptor.workflowId,
      workflow_type: descriptor.workflowType
    }
  );

  const startVerdict = dependencies.config.sendActivityStartEvent
    ? await evaluateActivityEvent(dependencies, {
        activity_id: descriptor.activityId,
        activity_input: startedInputForEvent,
        activity_type: descriptor.activityType,
        attempt: descriptor.attempt,
        event_type: WorkflowEventType.ACTIVITY_STARTED,
        ...(descriptor.goal ? { goal: descriptor.goal } : {}),
        run_id: descriptor.runId,
        task_queue: descriptor.taskQueue,
        workflow_id: descriptor.workflowId,
        workflow_type: descriptor.workflowType
      })
    : null;

  applyStopVerdict(startVerdict);
  assertGuardrailsValid(startVerdict, "Guardrails validation failed");

  if (
    startVerdict?.guardrailsResult?.inputType === "activity_input" &&
    startVerdict.guardrailsResult.redactedInput !== undefined
  ) {
    const normalizedRedactedInput = normalizeRedactedActivityInput(
      inputForExecution,
      startVerdict.guardrailsResult.redactedInput
    );
    inputForExecution = applyRedaction(
      inputForExecution,
      normalizedRedactedInput
    ) as TInput;
  }

  if (
    dependencies.config.hitlEnabled &&
    Verdict.requiresApproval(startVerdict?.verdict ?? Verdict.ALLOW)
  ) {
    const approvalPayload = {
      openbox: {
        activityId: descriptor.activityId,
        activityType: descriptor.activityType,
        approvalId: startVerdict?.approvalId,
        reason: startVerdict?.reason,
        requestedAt: rfc3339Now(),
        runId: descriptor.runId,
        workflowId: descriptor.workflowId,
        workflowType: descriptor.workflowType
      }
    };

    setPendingApproval({
      activityId: descriptor.activityId,
      activityType: descriptor.activityType,
      approvalId: startVerdict?.approvalId,
      requestedAt: approvalPayload.openbox.requestedAt,
      runId: descriptor.runId,
      workflowId: descriptor.workflowId,
      workflowType: descriptor.workflowType
    });

    const workflowSuspend = runtimeContext.workflow?.suspend;

    if (workflowSuspend) {
      return (await workflowSuspend(approvalPayload)) as TOutput | undefined;
    }

    await waitForApprovalInline(dependencies.client, descriptor, startVerdict?.reason);
  }

  return runWithOpenBoxExecutionContext(
    {
      activityId: descriptor.activityId,
      activityType: descriptor.activityType,
      attempt: descriptor.attempt,
      goal: descriptor.goal,
      runId: descriptor.runId,
      source: "tool",
      taskQueue: descriptor.taskQueue,
      workflowId: descriptor.workflowId,
      workflowType: descriptor.workflowType
    },
    async () => {
      let error: Record<string, unknown> | undefined;
      let haltReason: string | undefined;
      let output: TOutput | undefined;
      const activityStartMs = Date.now();

      try {
        output = await trace
          .getTracer("openbox.mastra")
          .startActiveSpan(`activity.${descriptor.activityType}`, async activeSpan => {
            activeSpan.setAttribute("openbox.workflow_id", descriptor.workflowId);
            activeSpan.setAttribute("openbox.activity_id", descriptor.activityId);
            activeSpan.setAttribute("openbox.run_id", descriptor.runId);
            dependencies.spanProcessor.registerTrace(
              activeSpan.spanContext().traceId,
              descriptor.workflowId,
              descriptor.activityId,
              descriptor.runId
            );

            try {
              return await execute(inputForExecution);
            } finally {
              activeSpan.end();
            }
          });
      } catch (caughtError) {
        if (
          caughtError instanceof ApprovalPendingError &&
          dependencies.config.hitlEnabled
        ) {
          const approvalPayload = {
            openbox: {
              activityId: descriptor.activityId,
              activityType: descriptor.activityType,
              approvalId: undefined,
              reason: caughtError.message,
              requestedAt: rfc3339Now(),
              runId: descriptor.runId,
              workflowId: descriptor.workflowId,
              workflowType: descriptor.workflowType
            }
          };

          setPendingApproval({
            activityId: descriptor.activityId,
            activityType: descriptor.activityType,
            approvalId: undefined,
            requestedAt: approvalPayload.openbox.requestedAt,
            runId: descriptor.runId,
            workflowId: descriptor.workflowId,
            workflowType: descriptor.workflowType
          });

          const workflowSuspend = runtimeContext.workflow?.suspend;

          if (workflowSuspend) {
            return (await workflowSuspend(approvalPayload)) as TOutput | undefined;
          }

          await waitForApprovalInline(
            dependencies.client,
            descriptor,
            caughtError.message
          );
        }

        error = serializeError(caughtError);
        throw caughtError;
      } finally {
        try {
          const wasAborted = dependencies.spanProcessor.getActivityAbort(
            descriptor.workflowId,
            descriptor.activityId
          );
          const activityEndMs = Date.now();
          const durationMs = Math.max(0, activityEndMs - activityStartMs);

          const alreadyApproved = isActivityApproved(
            descriptor.runId,
            descriptor.activityId
          );

          if (!wasAborted) {
            const completedInputForEvent = appendGoalToActivityInput(
              serializeActivityInputForCompletedEvent(inputForExecution),
              descriptor.goal
            );
            const completedActivityTypePayload =
              dependencies.config.hitlEnabled ? {} : { activity_type: descriptor.activityType };
            const completedVerdict = await evaluateActivityEvent(dependencies, {
              activity_id: descriptor.activityId,
              activity_input: completedInputForEvent,
              activity_output: serializeValue(output),
              ...completedActivityTypePayload,
              attempt: descriptor.attempt,
              duration_ms: durationMs,
              end_time: activityEndMs,
              error,
              event_type: WorkflowEventType.ACTIVITY_COMPLETED,
              ...(descriptor.goal ? { goal: descriptor.goal } : {}),
              run_id: descriptor.runId,
              span_count: 0,
              start_time: activityStartMs,
              status: error ? "failed" : "completed",
              task_queue: descriptor.taskQueue,
              workflow_id: descriptor.workflowId,
              workflow_type: descriptor.workflowType
            });

            applyStopVerdict(completedVerdict);
            assertGuardrailsValid(
              completedVerdict,
              "Guardrails output validation failed"
            );

            if (
              completedVerdict?.guardrailsResult?.inputType === "activity_output" &&
              completedVerdict.guardrailsResult.redactedInput !== undefined
            ) {
              output = applyRedaction(
                output,
                completedVerdict.guardrailsResult.redactedInput
              ) as TOutput;
            }

            if (
              dependencies.config.hitlEnabled &&
              Verdict.requiresApproval(completedVerdict?.verdict ?? Verdict.ALLOW) &&
              !alreadyApproved &&
              !isActivityApproved(descriptor.runId, descriptor.activityId)
            ) {
              const approvalPayload = {
                openbox: {
                  activityId: descriptor.activityId,
                  activityType: descriptor.activityType,
                  approvalId: completedVerdict?.approvalId,
                  reason: completedVerdict?.reason,
                  requestedAt: rfc3339Now(),
                  runId: descriptor.runId,
                  workflowId: descriptor.workflowId,
                  workflowType: descriptor.workflowType
                }
              };

              setPendingApproval({
                activityId: descriptor.activityId,
                activityType: descriptor.activityType,
                approvalId: completedVerdict?.approvalId,
                requestedAt: approvalPayload.openbox.requestedAt,
                runId: descriptor.runId,
                workflowId: descriptor.workflowId,
                workflowType: descriptor.workflowType
              });

              const workflowSuspend = runtimeContext.workflow?.suspend;

              if (workflowSuspend) {
                output = (await workflowSuspend(approvalPayload)) as
                  | TOutput
                  | undefined;
              } else {
                await waitForApprovalInline(
                  dependencies.client,
                  descriptor,
                  completedVerdict?.reason ??
                    "Activity output requires human approval"
                );
              }
            }
          }

          haltReason = dependencies.spanProcessor.getHaltRequested(
            descriptor.workflowId,
            descriptor.activityId
          );
        } finally {
          dependencies.spanProcessor.clearActivityAbort(
            descriptor.workflowId,
            descriptor.activityId
          );
          dependencies.spanProcessor.clearHaltRequested(
            descriptor.workflowId,
            descriptor.activityId
          );
          dependencies.spanProcessor.clearActivityContext(
            descriptor.workflowId,
            descriptor.activityId
          );
          clearActivityApproval(descriptor.runId, descriptor.activityId);
        }
      }

      if (haltReason) {
        throw new GovernanceHaltError(`Governance blocked: ${haltReason}`);
      }

      return output;
    }
  );
}

const INLINE_APPROVAL_TIMEOUT_MS = 300_000;
const INLINE_APPROVAL_INITIAL_POLL_INTERVAL_MS = 2_500;
const INLINE_APPROVAL_MAX_POLL_INTERVAL_MS = 15_000;
const INLINE_APPROVAL_BACKOFF_MULTIPLIER = 2;
const inflightInlineApprovalWaits = new Map<string, Promise<void>>();

async function waitForApprovalInline(
  client: OpenBoxClient,
  descriptor: ReturnType<typeof resolveActivityDescriptor>,
  reason: string | undefined
): Promise<void> {
  const inflightKey = `${descriptor.runId}::${descriptor.activityId}`;
  const existingWait = inflightInlineApprovalWaits.get(inflightKey);

  if (existingWait) {
    await existingWait;
    return;
  }

  const waitPromise = (async () => {
    const timeoutAt = Date.now() + INLINE_APPROVAL_TIMEOUT_MS;
    let pollIntervalMs = INLINE_APPROVAL_INITIAL_POLL_INTERVAL_MS;

    while (Date.now() < timeoutAt) {
      await delay(pollIntervalMs);

      if (Date.now() >= timeoutAt) {
        break;
      }

      const approval = await client.pollApproval({
        activityId: descriptor.activityId,
        runId: descriptor.runId,
        workflowId: descriptor.workflowId
      });

      if (!approval) {
        pollIntervalMs = Math.min(
          INLINE_APPROVAL_MAX_POLL_INTERVAL_MS,
          Math.ceil(pollIntervalMs * INLINE_APPROVAL_BACKOFF_MULTIPLIER)
        );
        continue;
      }

      if (approval.expired) {
        clearPendingApproval(descriptor.runId);
        throw new ApprovalExpiredError(
          `Approval expired for activity ${descriptor.activityType}`
        );
      }

      const verdict = Verdict.fromString(
        (approval.verdict) ??
          (approval.action)
      );

      if (verdict === Verdict.ALLOW) {
        markActivityApproved(descriptor.runId, descriptor.activityId);
        clearPendingApproval(descriptor.runId);
        return;
      }

      if (Verdict.shouldStop(verdict)) {
        clearPendingApproval(descriptor.runId);
        throw new ApprovalRejectedError(
          `Activity rejected: ${String(approval.reason ?? "Activity rejected")}`
        );
      }

      pollIntervalMs = Math.min(
        INLINE_APPROVAL_MAX_POLL_INTERVAL_MS,
        Math.ceil(pollIntervalMs * INLINE_APPROVAL_BACKOFF_MULTIPLIER)
      );
    }

    throw new ApprovalPendingError(
      reason ?? `Awaiting approval for activity ${descriptor.activityType}`
    );
  })();

  inflightInlineApprovalWaits.set(inflightKey, waitPromise);

  try {
    await waitPromise;
  } finally {
    inflightInlineApprovalWaits.delete(inflightKey);
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

export function serializeValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeValue(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        serializeValue(entry)
      ])
    );
  }

  return String(value);
}

export function normalizeSpansForGovernance(
  spans: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return spans.map(span => normalizeSpanForGovernance(span));
}

function serializeActivityInputForStartEvent(value: unknown): unknown {
  const serialized = serializeValue(value);

  if (serialized == null) {
    return [];
  }

  return serialized;
}

// Guardrails need direct field access on ActivityStarted payloads, while the
// current AGE service still expects ActivityCompleted.activity_input as a list.
function serializeActivityInputForCompletedEvent(value: unknown): unknown[] {
  const serialized = serializeValue(value);

  if (serialized == null) {
    return [];
  }

  return Array.isArray(serialized) ? serialized : [serialized];
}

export function appendGoalToActivityInput(
  activityInput: unknown,
  goal: string | undefined
): unknown {
  if (!goal || goal.trim().length === 0) {
    return activityInput;
  }

  const trimmedGoal = goal.trim();

  if (trimmedGoal.length === 0) {
    return activityInput;
  }

  if (Array.isArray(activityInput)) {
    const inputItems = activityInput as unknown[];

    if (inputItems.length === 0) {
      return [{ goal: trimmedGoal }];
    }

    const [first, ...rest] = inputItems;

    if (first && typeof first === "object" && !Array.isArray(first)) {
      const firstRecord = first as Record<string, unknown>;
      const existingGoal = firstRecord.goal;

      if (typeof existingGoal === "string" && existingGoal.trim().length > 0) {
        return inputItems;
      }

      return [{ ...firstRecord, goal: trimmedGoal }, ...rest];
    }

    return [...inputItems, { goal: trimmedGoal }];
  }

  if (activityInput === undefined || activityInput === null) {
    return [{ goal: trimmedGoal }];
  }

  if (activityInput && typeof activityInput === "object") {
    const activityRecord = activityInput as Record<string, unknown>;
    const existingGoal = activityRecord.goal;

    if (typeof existingGoal === "string" && existingGoal.trim().length > 0) {
      return activityInput;
    }

    return {
      ...activityRecord,
      goal: trimmedGoal
    };
  }

  return [activityInput, { goal: trimmedGoal }];
}

function normalizeRedactedActivityInput(
  originalInput: unknown,
  redactedInput: unknown
): unknown {
  // Governance services may return activity_input redaction in list form.
  // For single-argument tools/steps, unwrap list->value so execution shape is preserved.
  if (!Array.isArray(originalInput) && Array.isArray(redactedInput)) {
    if (redactedInput.length === 0) {
      return redactedInput;
    }

    if (redactedInput.length === 1) {
      return redactedInput[0];
    }
  }

  return redactedInput;
}

export function applyRedaction(original: unknown, redacted: unknown): unknown {
  if (
    original &&
    redacted &&
    typeof original === "object" &&
    typeof redacted === "object" &&
    !Array.isArray(original) &&
    !Array.isArray(redacted)
  ) {
    const updated: Record<string, unknown> = {
      ...(original as Record<string, unknown>)
    };

    for (const [key, value] of Object.entries(redacted as Record<string, unknown>)) {
      updated[key] = applyRedaction(
        (original as Record<string, unknown>)[key],
        value
      );
    }

    return updated;
  }

  if (Array.isArray(redacted)) {
    return redacted.map((value, index) =>
      applyRedaction(Array.isArray(original) ? original[index] : undefined, value)
    );
  }

  return cloneValue(redacted);
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return structuredClone(value);
}

function rfc3339Now(): string {
  return new Date().toISOString();
}

function resolveActivityDescriptor(
  type: string,
  runtimeContext: ToolExecutionContextLike
): {
  activityId: string;
  activityType: string;
  attempt: number;
  goal?: string;
  runId: string;
  taskQueue: string;
  workflowId: string;
  workflowType: string;
} {
  const normalizedType = normalizeActivityType(type);
  const activeContext = getOpenBoxExecutionContext();
  const runId =
    runtimeContext.workflow?.runId ??
    activeContext?.runId ??
    runtimeContext.agent?.toolCallId ??
    randomUUID();
  const workflowId =
    runtimeContext.workflow?.workflowId ??
    activeContext?.workflowId ??
    `tool:${type}`;
  const workflowType = activeContext?.workflowType ?? workflowId;
  const activityId =
    runtimeContext.agent?.toolCallId ??
    activeContext?.activityId ??
    `${workflowId}:${type}`;

  return {
    activityId,
    activityType: normalizedType,
    attempt: activeContext?.attempt ?? 1,
    ...(activeContext?.goal ? { goal: activeContext.goal } : {}),
    runId,
    taskQueue: activeContext?.taskQueue ?? "mastra",
    workflowId,
    workflowType
  };
}

function normalizeActivityType(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "activity";
  }

  if (/^[a-z][A-Za-z0-9]*$/.test(trimmed)) {
    return trimmed;
  }

  const tokens = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(token => token.toLowerCase());

  if (tokens.length === 0) {
    return "activity";
  }

  const [first, ...rest] = tokens;
  return `${first}${rest
    .map(token => token.charAt(0).toUpperCase() + token.slice(1))
    .join("")}`;
}

async function evaluateActivityEvent(
  dependencies: ActivityRuntimeDependencies,
  payload: Record<string, unknown> & {
    event_type: WorkflowEventType;
  }
): Promise<GovernanceVerdictResponse | null> {
  const body = {
    source: "workflow-telemetry",
    timestamp: rfc3339Now(),
    ...payload
  };

  try {
    return await dependencies.client.evaluate(body);
  } catch (error) {
    if (dependencies.config.onApiError === "fail_closed") {
      return new GovernanceVerdictResponse({
        reason: `Governance API error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        verdict: Verdict.HALT
      });
    }

    return null;
  }
}

function applyStopVerdict(
  verdict: GovernanceVerdictResponse | null
): void {
  if (verdict && Verdict.shouldStop(verdict.verdict)) {
    throw new GovernanceHaltError(
      `Governance blocked: ${verdict.reason ?? "No reason provided"}`
    );
  }
}

function assertGuardrailsValid(
  verdict: GovernanceVerdictResponse | null,
  fallbackMessage: string
): void {
  if (!verdict?.guardrailsResult || verdict.guardrailsResult.validationPassed) {
    return;
  }

  const reasons = verdict.guardrailsResult.getReasonStrings();
  const reason = reasons.length > 0 ? reasons.join("; ") : fallbackMessage;

  throw new GuardrailsValidationError(reason);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      type: error.name
    };
  }

  return {
    message: String(error),
    type: typeof error
  };
}

function ensureSpanBuffer(
  descriptor: {
    runId: string;
    taskQueue: string;
    workflowId: string;
    workflowType: string;
  },
  spanProcessor: OpenBoxSpanProcessor
): void {
  const existing = spanProcessor.getBuffer(
    descriptor.workflowId,
    descriptor.runId
  );

  if (!existing || existing.runId !== descriptor.runId) {
    spanProcessor.registerWorkflow(
      descriptor.workflowId,
      new WorkflowSpanBuffer({
        runId: descriptor.runId,
        taskQueue: descriptor.taskQueue,
        workflowId: descriptor.workflowId,
        workflowType: descriptor.workflowType
      })
    );
  }
}

function normalizeSpanForGovernance(
  span: Record<string, unknown>
): Record<string, unknown> {
  const attributes = asRecord(span.attributes);
  const normalizedAttributes = {
    ...attributes
  };
  const urlFull = toStringOrUndefined(normalizedAttributes["url.full"]);

  if (!toStringOrUndefined(normalizedAttributes["http.url"]) && urlFull) {
    normalizedAttributes["http.url"] = urlFull;
  }

  const normalized: Record<string, unknown> = {
    attributes: normalizedAttributes,
    end_time: toFiniteNumber(span.end_time ?? span.endTime),
    events: normalizeSpanEvents(span.events),
    name: toStringOrUndefined(span.name),
    span_id: toStringOrUndefined(span.span_id ?? span.spanId),
    start_time: toFiniteNumber(span.start_time ?? span.startTime),
    trace_id: toStringOrUndefined(span.trace_id ?? span.traceId)
  };
  const parentSpanId = toStringOrUndefined(
    span.parent_span_id ?? span.parentSpanId
  );
  const kind = toStringOrUndefined(span.kind);
  const durationNs =
    toFiniteNumber(span.duration_ns ?? span.durationNs) ??
    calculateDurationNs(normalized.start_time, normalized.end_time);
  const status = normalizeSpanStatus(span.status);
  const requestHeaders = toStringRecord(
    span.request_headers ?? span.requestHeaders
  );
  const responseHeaders = toStringRecord(
    span.response_headers ?? span.responseHeaders
  );
  const requestBody = toStringOrUndefined(span.request_body ?? span.requestBody);
  const responseBody = toStringOrUndefined(span.response_body ?? span.responseBody);
  const semanticType = toStringOrUndefined(
    span.semantic_type ?? span.semanticType
  );

  if (parentSpanId) {
    normalized.parent_span_id = parentSpanId;
  }

  if (kind) {
    normalized.kind = kind;
  }

  if (durationNs !== undefined) {
    normalized.duration_ns = durationNs;
  }

  if (status) {
    normalized.status = status;
  }

  if (requestHeaders) {
    normalized.request_headers = requestHeaders;
  }

  if (responseHeaders) {
    normalized.response_headers = responseHeaders;
  }

  if (requestBody !== undefined) {
    normalized.request_body = requestBody;
  }

  if (responseBody !== undefined) {
    normalized.response_body = responseBody;
  }

  if (semanticType) {
    normalized.semantic_type = semanticType;
  }

  return normalized;
}

function calculateDurationNs(
  startTime: unknown,
  endTime: unknown
): number | undefined {
  if (typeof startTime !== "number" || typeof endTime !== "number") {
    return undefined;
  }

  return Math.max(0, endTime - startTime);
}

function normalizeSpanEvents(events: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.map(event => {
    const eventRecord = asRecord(event);

    return {
      attributes: asRecord(eventRecord.attributes),
      name: toStringOrUndefined(eventRecord.name) ?? "",
      timestamp: toFiniteNumber(eventRecord.timestamp) ?? 0
    };
  });
}

function normalizeSpanStatus(
  status: unknown
): Record<string, unknown> | undefined {
  const statusRecord = asRecord(status);
  const code = toStringOrUndefined(statusRecord.code);
  const description = toStringOrUndefined(statusRecord.description);

  if (!code && !description) {
    return undefined;
  }

  return {
    ...(code ? { code } : {}),
    ...(description ? { description } : {})
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toStringRecord(
  value: unknown
): Record<string, string> | undefined {
  const record = asRecord(value);

  if (Object.keys(record).length === 0) {
    return undefined;
  }

  const serialized = Object.fromEntries(
    Object.entries(record).flatMap(([key, entry]) =>
      typeof entry === "string" ? ([[key, entry]] as const) : []
    )
  );

  return Object.keys(serialized).length > 0 ? serialized : undefined;
}
