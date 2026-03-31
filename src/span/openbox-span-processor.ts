import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor
} from "@opentelemetry/sdk-trace-base";

import type { WorkflowSpanBuffer } from "../types/index.js";
import { type Verdict } from "../types/index.js";

export interface StoredSpanBody {
  requestBody?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
}

export interface StoredTraceBody extends StoredSpanBody {
  method?: string | undefined;
  url?: string | undefined;
}

export interface StoredWorkflowVerdict {
  reason?: string | undefined;
  runId?: string | undefined;
  verdict: Verdict;
}

export interface OpenBoxSpanData {
  activityId?: string | undefined;
  attributes: Record<string, unknown>;
  durationNs?: number | undefined;
  endTime?: number | undefined;
  events: Array<{
    attributes: Record<string, unknown>;
    name: string;
    timestamp: number;
  }>;
  kind?: string | undefined;
  name: string;
  parentSpanId?: string | undefined;
  requestBody?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  spanId: string;
  startTime?: number | undefined;
  status?: {
    code: string;
    description?: string | undefined;
  } | undefined;
  traceId: string;
}

export interface OpenBoxSpanProcessorOptions {
  fallbackProcessor?: {
    forceFlush: (timeoutMillis?: number) => Promise<void> | void | boolean;
    onEnd: (span: ReadableSpan) => void;
    shutdown: () => Promise<void> | void;
  };
  ignoredUrlPrefixes?: string[] | undefined;
}

type SpanLike = Pick<
  ReadableSpan,
  | "attributes"
  | "endTime"
  | "events"
  | "kind"
  | "name"
  | "parentSpanContext"
  | "startTime"
> & {
  context: {
    spanId?: number;
    traceId?: number;
    span_id?: number;
    trace_id?: number;
  } | undefined;
  spanContext?: (() => {
    spanId: string;
    traceId: string;
  }) | undefined;
  status?: {
    description?: string;
    statusCode?: { name?: string } | { name: string } | number;
    status_code?: { name?: string } | { name: string } | number;
  };
};

export class OpenBoxSpanProcessor implements SpanProcessor {
  readonly #abortedActivities = new Map<string, string>();
  readonly #activityContext = new Map<string, Record<string, unknown>>();
  readonly #agentSignalHookSpans = new Map<string, Array<Record<string, unknown>>>();
  readonly #bodyData = new Map<string, StoredSpanBody>();
  readonly #buffers = new Map<string, WorkflowSpanBuffer>();
  readonly #governedSpanIds = new Set<string>();
  readonly #haltRequests = new Map<string, string>();
  readonly #activeWorkflowRunKey = new Map<string, string>();
  readonly #traceBodyData = new Map<string, StoredTraceBody[]>();
  readonly #ignoredUrlPrefixes: Set<string>;
  readonly #traceToActivity = new Map<string, string>();
  readonly #traceToRunId = new Map<string, string>();
  readonly #traceToWorkflow = new Map<string, string>();
  readonly #workflowRunKeys = new Map<string, Set<string>>();
  readonly #verdicts = new Map<string, StoredWorkflowVerdict>();

  public readonly fallbackProcessor?: OpenBoxSpanProcessorOptions["fallbackProcessor"];

  public constructor({
    fallbackProcessor,
    ignoredUrlPrefixes
  }: OpenBoxSpanProcessorOptions = {}) {
    this.fallbackProcessor = fallbackProcessor;
    this.#ignoredUrlPrefixes = new Set(ignoredUrlPrefixes ?? []);
  }

  public registerWorkflow(workflowId: string, buffer: WorkflowSpanBuffer): void {
    const runKey = toWorkflowRunKey(workflowId, buffer.runId);
    this.#buffers.set(runKey, buffer);
    this.#activeWorkflowRunKey.set(workflowId, runKey);
    const existingKeys = this.#workflowRunKeys.get(workflowId) ?? new Set<string>();
    existingKeys.add(runKey);
    this.#workflowRunKeys.set(workflowId, existingKeys);
  }

  public registerTrace(
    traceId: number | string,
    workflowId: string,
    activityId?: string,
    runId?: string
  ): void {
    const normalizedTraceId = normalizeHexId(traceId, 32);

    this.#traceToWorkflow.set(normalizedTraceId, workflowId);
    if (runId) {
      this.#traceToRunId.set(normalizedTraceId, runId);
    }

    if (activityId) {
      this.#traceToActivity.set(normalizedTraceId, activityId);
    }
  }

  public setActivityContext(
    workflowId: string,
    activityId: string,
    context: Record<string, unknown>
  ): void {
    this.#activityContext.set(
      toActivityKey(workflowId, activityId),
      {
        ...context
      }
    );
  }

  public getActivityContext(
    workflowId: string,
    activityId: string
  ): Record<string, unknown> | undefined {
    return this.#activityContext.get(toActivityKey(workflowId, activityId));
  }

  public getActivityContextByTrace(
    traceId: number | string
  ): Record<string, unknown> | undefined {
    const normalizedTraceId = normalizeHexId(traceId, 32);
    const workflowId = this.#traceToWorkflow.get(normalizedTraceId);
    const activityId = this.#traceToActivity.get(normalizedTraceId);

    if (!workflowId || !activityId) {
      return undefined;
    }

    return this.getActivityContext(workflowId, activityId);
  }

  public clearActivityContext(workflowId: string, activityId: string): void {
    this.#activityContext.delete(toActivityKey(workflowId, activityId));
  }

  public setActivityAbort(
    workflowId: string,
    activityId: string,
    reason: string
  ): void {
    this.#abortedActivities.set(toActivityKey(workflowId, activityId), reason);
  }

  public getActivityAbort(
    workflowId: string,
    activityId: string
  ): string | undefined {
    return this.#abortedActivities.get(toActivityKey(workflowId, activityId));
  }

  public clearActivityAbort(workflowId: string, activityId: string): void {
    this.#abortedActivities.delete(toActivityKey(workflowId, activityId));
  }

  public setHaltRequested(
    workflowId: string,
    activityId: string,
    reason: string
  ): void {
    this.#haltRequests.set(toActivityKey(workflowId, activityId), reason);
  }

  public getHaltRequested(
    workflowId: string,
    activityId: string
  ): string | undefined {
    return this.#haltRequests.get(toActivityKey(workflowId, activityId));
  }

  public clearHaltRequested(workflowId: string, activityId: string): void {
    this.#haltRequests.delete(toActivityKey(workflowId, activityId));
  }

  public markGoverned(spanId: number | string): void {
    this.#governedSpanIds.add(normalizeHexId(spanId, 16));

    if (this.#governedSpanIds.size > 10_000) {
      this.#governedSpanIds.clear();
    }
  }

  public getBuffer(workflowId: string, runId?: string): WorkflowSpanBuffer | undefined {
    if (runId) {
      const scoped = this.#buffers.get(toWorkflowRunKey(workflowId, runId));

      if (scoped) {
        return scoped;
      }
    }

    const activeKey = this.#activeWorkflowRunKey.get(workflowId);

    if (!activeKey) {
      return undefined;
    }

    return this.#buffers.get(activeKey);
  }

  public removeBuffer(workflowId: string, runId?: string): WorkflowSpanBuffer | undefined {
    if (runId) {
      return this.#removeRunScopedBuffer(workflowId, runId);
    }

    const activeKey = this.#activeWorkflowRunKey.get(workflowId);

    if (!activeKey) {
      return undefined;
    }

    const buffer = this.#buffers.get(activeKey);
    this.#buffers.delete(activeKey);
    this.#agentSignalHookSpans.delete(activeKey);
    this.#removeRunKey(workflowId, activeKey);
    this.#updateActiveRunKey(workflowId);

    return buffer;
  }

  public unregisterWorkflow(workflowId: string, runId?: string): void {
    if (runId) {
      this.#removeRunScopedBuffer(workflowId, runId);
      this.#verdicts.delete(toWorkflowRunKey(workflowId, runId));
      this.#deleteWorkflowScopedMaps(workflowId);
      return;
    }

    const runKeys = this.#workflowRunKeys.get(workflowId);

    if (runKeys) {
      for (const runKey of runKeys) {
        this.#buffers.delete(runKey);
        this.#agentSignalHookSpans.delete(runKey);
        this.#verdicts.delete(runKey);
      }
    }

    this.#workflowRunKeys.delete(workflowId);
    this.#activeWorkflowRunKey.delete(workflowId);
    this.#verdicts.delete(workflowId);
    this.#deleteWorkflowScopedMaps(workflowId);
  }

  public setVerdict(
    workflowId: string,
    verdict: Verdict,
    reason?: string,
    runId?: string
  ): void {
    const verdictKey = runId
      ? toWorkflowRunKey(workflowId, runId)
      : (this.#activeWorkflowRunKey.get(workflowId) ?? workflowId);
    this.#verdicts.set(verdictKey, { reason, runId, verdict });

    const buffer = runId
      ? this.getBuffer(workflowId, runId)
      : this.getBuffer(workflowId);

    if (buffer) {
      buffer.verdict = verdict;
      buffer.verdictReason = reason;
    }
  }

  public getVerdict(workflowId: string, runId?: string): StoredWorkflowVerdict | undefined {
    if (runId) {
      return this.#verdicts.get(toWorkflowRunKey(workflowId, runId));
    }

    const activeKey = this.#activeWorkflowRunKey.get(workflowId);

    if (activeKey) {
      const scopedVerdict = this.#verdicts.get(activeKey);

      if (scopedVerdict) {
        return scopedVerdict;
      }
    }

    return this.#verdicts.get(workflowId);
  }

  public clearVerdict(workflowId: string, runId?: string): void {
    if (runId) {
      this.#verdicts.delete(toWorkflowRunKey(workflowId, runId));
      return;
    }

    const activeKey = this.#activeWorkflowRunKey.get(workflowId);

    if (activeKey) {
      this.#verdicts.delete(activeKey);
    }

    this.#verdicts.delete(workflowId);
  }

  public appendAgentSignalHookSpan(
    workflowId: string,
    runId: string,
    span: Record<string, unknown>
  ): void {
    const runKey = toWorkflowRunKey(workflowId, runId);
    const existing = this.#agentSignalHookSpans.get(runKey) ?? [];

    existing.push(cloneRecord(span));
    this.#agentSignalHookSpans.set(runKey, existing);
  }

  public consumeAgentSignalHookSpans(
    workflowId: string,
    runId: string
  ): Array<Record<string, unknown>> {
    const runKey = toWorkflowRunKey(workflowId, runId);
    const spans = this.#agentSignalHookSpans.get(runKey) ?? [];

    this.#agentSignalHookSpans.delete(runKey);

    return spans.map(span => cloneRecord(span));
  }

  public storeBody(spanId: number | string, body: StoredSpanBody): void {
    const normalizedSpanId = normalizeHexId(spanId, 16);
    const current = this.#bodyData.get(normalizedSpanId) ?? {};
    this.#bodyData.set(normalizedSpanId, {
      ...current,
      ...body
    });
  }

  public storeTraceBody(
    traceId: number | string,
    body: StoredTraceBody
  ): void {
    const normalizedTraceId = normalizeHexId(traceId, 32);
    const normalizedBody = normalizeTraceBody(body);

    if (this.#attachTraceBodyToBufferedSpan(normalizedTraceId, normalizedBody)) {
      return;
    }

    const existing = this.#traceBodyData.get(normalizedTraceId) ?? [];
    existing.push(normalizedBody);
    this.#traceBodyData.set(normalizedTraceId, existing);
  }

  public getPendingBody(spanId: number | string): StoredSpanBody | undefined {
    return this.#bodyData.get(normalizeHexId(spanId, 16));
  }

  public onStart(span: ReadableSpan, parentContext: Context): void {
    const spanLike = span as unknown as SpanLike;
    this.#registerCorrelation(spanLike);
    void parentContext;
  }

  public onEnd(span: ReadableSpan): void {
    const spanLike = span as unknown as SpanLike;
    const spanId = getSpanId(spanLike);

    if (spanId && this.#governedSpanIds.delete(spanId)) {
      this.#bodyData.delete(spanId);
      this.fallbackProcessor?.onEnd(span);
      return;
    }

    if (this.#shouldIgnoreSpan(spanLike)) {
      this.fallbackProcessor?.onEnd(span);
      return;
    }

    this.#registerCorrelation(spanLike);

    const traceId = getTraceId(spanLike);
    const attributes = toRecord(spanLike.attributes);
    const workflowId =
      toStringAttribute(attributes["openbox.workflow_id"]) ??
      (traceId != null ? this.#traceToWorkflow.get(traceId) : undefined);
    const runId =
      toStringAttribute(attributes["openbox.run_id"]) ??
      (traceId != null ? this.#traceToRunId.get(traceId) : undefined);
    const activityId =
      toStringAttribute(attributes["openbox.activity_id"]) ??
      (traceId != null ? this.#traceToActivity.get(traceId) : undefined);

    if (workflowId) {
      const buffer = this.getBuffer(workflowId, runId);

      if (buffer) {
        const spanData = this.extractSpanData(span);

        if (activityId) {
          spanData.activityId = activityId;
        }

        if (spanId != null) {
          const body = this.#bodyData.get(spanId);

          if (body) {
            spanData.requestBody = body.requestBody;
            spanData.responseBody = body.responseBody;
            spanData.requestHeaders = body.requestHeaders;
            spanData.responseHeaders = body.responseHeaders;
            this.#bodyData.delete(spanId);
          }
        }

        const traceBody =
          traceId != null
            ? this.#consumeTraceBodyForSpan(traceId, spanData.attributes)
            : undefined;

        if (
          traceBody &&
          spanData.requestBody === undefined &&
          spanData.responseBody === undefined
        ) {
          spanData.requestBody = traceBody.requestBody;
          spanData.responseBody = traceBody.responseBody;
          spanData.requestHeaders = traceBody.requestHeaders;
          spanData.responseHeaders = traceBody.responseHeaders;
        }

        buffer.spans.push(spanData as unknown as Record<string, unknown>);
      }
    }

    this.fallbackProcessor?.onEnd(span);
  }

  public async shutdown(): Promise<void> {
    await this.fallbackProcessor?.shutdown();
  }

  public async forceFlush(timeoutMillis = 30_000): Promise<void> {
    await this.fallbackProcessor?.forceFlush(timeoutMillis);
  }

  public extractSpanData(span: ReadableSpan): OpenBoxSpanData {
    const spanLike = span as unknown as SpanLike;
    const traceId = getTraceId(spanLike) ?? "0";
    const spanId = getSpanId(spanLike) ?? "0";
    const parentSpanId = getParentSpanId(spanLike);
    const events = (spanLike.events ?? []).map(event => ({
      attributes: toRecord(event.attributes),
      name: event.name,
      timestamp: hrTimeToNanoseconds(
        (event as { time?: [number, number] | number; timestamp?: [number, number] | number }).time ??
          (event as { timestamp?: [number, number] | number }).timestamp
      ) ?? 0
    }));
    const statusCode =
      getStatusCodeName(spanLike.status?.statusCode) ??
      getStatusCodeName(spanLike.status?.status_code);
    const startTime = hrTimeToNanoseconds(spanLike.startTime);
    const endTime = hrTimeToNanoseconds(spanLike.endTime);

    return {
      attributes: toRecord(spanLike.attributes),
      durationNs:
        startTime != null && endTime != null ? endTime - startTime : undefined,
      endTime,
      events,
      kind: getSpanKindName(spanLike.kind),
      name: spanLike.name,
      parentSpanId,
      spanId,
      startTime,
      status: statusCode
        ? {
            code: statusCode,
            description: spanLike.status?.description
          }
        : undefined,
      traceId
    };
  }

  #shouldIgnoreSpan(span: SpanLike): boolean {
    const url = toStringAttribute(toRecord(span.attributes)["http.url"]);

    if (!url) {
      return false;
    }

    for (const prefix of this.#ignoredUrlPrefixes) {
      if (url.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  #registerCorrelation(span: SpanLike): void {
    const traceId = getTraceId(span);

    if (!traceId) {
      return;
    }

    const attributes = toRecord(span.attributes);
    const workflowId = toStringAttribute(attributes["openbox.workflow_id"]);
    const activityId = toStringAttribute(attributes["openbox.activity_id"]);
    const runId = toStringAttribute(attributes["openbox.run_id"]);

    if (workflowId) {
      this.#traceToWorkflow.set(traceId, workflowId);
    }

    if (runId) {
      this.#traceToRunId.set(traceId, runId);
    }

    if (activityId) {
      this.#traceToActivity.set(traceId, activityId);
    }
  }

  #consumeTraceBodyForSpan(
    traceId: string,
    attributes: Record<string, unknown>
  ): StoredTraceBody | undefined {
    const spanUrl = normalizeHttpUrl(
      toStringAttribute(attributes["http.url"]) ??
        toStringAttribute(attributes["url.full"])
    );

    if (!spanUrl) {
      return undefined;
    }

    const spanMethod = normalizeHttpMethod(
      toStringAttribute(attributes["http.method"])
    );
    const entries = this.#traceBodyData.get(traceId);

    if (!entries || entries.length === 0) {
      return undefined;
    }

    const index = entries.findIndex(entry => {
      const sameUrl = entry.url === undefined || entry.url === spanUrl;
      const sameMethod =
        entry.method === undefined || spanMethod === undefined || entry.method === spanMethod;

      return sameUrl && sameMethod;
    });

    if (index === -1) {
      return undefined;
    }

    const [matched] = entries.splice(index, 1);

    if (entries.length === 0) {
      this.#traceBodyData.delete(traceId);
    } else {
      this.#traceBodyData.set(traceId, entries);
    }

    return matched;
  }

  #attachTraceBodyToBufferedSpan(
    traceId: string,
    body: StoredTraceBody
  ): boolean {
    const workflowId = this.#traceToWorkflow.get(traceId);

    if (!workflowId) {
      return false;
    }

    const runId = this.#traceToRunId.get(traceId);
    const buffer = this.getBuffer(workflowId, runId);

    if (!buffer || buffer.spans.length === 0) {
      return false;
    }

    for (let index = buffer.spans.length - 1; index >= 0; index -= 1) {
      const candidate = buffer.spans[index];

      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const spanRecord = candidate;
      const spanTraceId = normalizeHttpTraceId(
        toStringAttribute(spanRecord.traceId) ??
          toStringAttribute(spanRecord.trace_id)
      );

      if (spanTraceId !== traceId) {
        continue;
      }

      const attributes = toRecord(
        spanRecord.attributes as Record<string, unknown> | undefined
      );

      if (!traceBodyMatchesSpan(body, attributes)) {
        continue;
      }

      if (
        spanRecord.requestBody !== undefined ||
        spanRecord.responseBody !== undefined ||
        spanRecord.request_body !== undefined ||
        spanRecord.response_body !== undefined
      ) {
        return true;
      }

      spanRecord.requestBody = body.requestBody;
      spanRecord.responseBody = body.responseBody;
      spanRecord.requestHeaders = body.requestHeaders;
      spanRecord.responseHeaders = body.responseHeaders;
      return true;
    }

    return false;
  }

  #removeRunScopedBuffer(
    workflowId: string,
    runId: string
  ): WorkflowSpanBuffer | undefined {
    const runKey = toWorkflowRunKey(workflowId, runId);
    const buffer = this.#buffers.get(runKey);
    this.#buffers.delete(runKey);
    this.#agentSignalHookSpans.delete(runKey);
    this.#removeRunKey(workflowId, runKey);
    this.#updateActiveRunKey(workflowId);

    return buffer;
  }

  #removeRunKey(workflowId: string, runKey: string): void {
    const runKeys = this.#workflowRunKeys.get(workflowId);

    if (!runKeys) {
      return;
    }

    runKeys.delete(runKey);

    if (runKeys.size === 0) {
      this.#workflowRunKeys.delete(workflowId);
    }
  }

  #updateActiveRunKey(workflowId: string): void {
    const runKeys = this.#workflowRunKeys.get(workflowId);

    if (!runKeys || runKeys.size === 0) {
      this.#activeWorkflowRunKey.delete(workflowId);
      return;
    }

    const nextKey = Array.from(runKeys).at(-1);

    if (nextKey) {
      this.#activeWorkflowRunKey.set(workflowId, nextKey);
    } else {
      this.#activeWorkflowRunKey.delete(workflowId);
    }
  }

  #deleteWorkflowScopedMaps(workflowId: string): void {
    const prefix = `${workflowId}::`;

    for (const key of this.#activityContext.keys()) {
      if (key.startsWith(prefix)) {
        this.#activityContext.delete(key);
      }
    }

    for (const key of this.#abortedActivities.keys()) {
      if (key.startsWith(prefix)) {
        this.#abortedActivities.delete(key);
      }
    }

    for (const key of this.#haltRequests.keys()) {
      if (key.startsWith(prefix)) {
        this.#haltRequests.delete(key);
      }
    }
  }
}

export const WorkflowSpanProcessor = OpenBoxSpanProcessor;

function toWorkflowRunKey(workflowId: string, runId: string): string {
  return `${workflowId}::${runId}`;
}

function toActivityKey(workflowId: string, activityId: string): string {
  return `${workflowId}::${activityId}`;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

function formatHex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

function normalizeHexId(value: number | string, width: number): string {
  return typeof value === "string" ? value.padStart(width, "0") : formatHex(value, width);
}

function getParentSpanId(span: SpanLike): string | undefined {
  if (span.parentSpanContext?.spanId) {
    return span.parentSpanContext.spanId.padStart(16, "0");
  }

  return undefined;
}

function getSpanKindName(kind: { name?: string } | number | undefined): string | undefined {
  if (typeof kind === "number") {
    return (
      {
        0: "INTERNAL",
        1: "SERVER",
        2: "CLIENT",
        3: "PRODUCER",
        4: "CONSUMER"
      }[kind] ?? "INTERNAL"
    );
  }

  return kind?.name;
}

function getSpanId(span: SpanLike): string | undefined {
  const fromContext = span.spanContext?.().spanId;

  if (fromContext) {
    return fromContext.padStart(16, "0");
  }

  if (span.context?.spanId != null) {
    return formatHex(span.context.spanId, 16);
  }

  if (span.context?.span_id != null) {
    return formatHex(span.context.span_id, 16);
  }

  return undefined;
}

function getStatusCodeName(
  statusCode: { name?: string } | number | undefined
): string | undefined {
  if (typeof statusCode === "number") {
    return (
      {
        0: "UNSET",
        1: "OK",
        2: "ERROR"
      }[statusCode] ?? "UNSET"
    );
  }

  return statusCode?.name;
}

function getTraceId(span: SpanLike): string | undefined {
  const fromContext = span.spanContext?.().traceId;

  if (fromContext) {
    return fromContext.padStart(32, "0");
  }

  if (span.context?.traceId != null) {
    return formatHex(span.context.traceId, 32);
  }

  if (span.context?.trace_id != null) {
    return formatHex(span.context.trace_id, 32);
  }

  return undefined;
}

function hrTimeToNanoseconds(
  value: [number, number] | number | undefined
): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] * 1_000_000_000 + value[1];
  }

  return undefined;
}

function toRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> {
  return value ? { ...value } : {};
}

function toStringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeHttpMethod(value: string | undefined): string | undefined {
  return value ? value.toUpperCase() : undefined;
}

function normalizeHttpTraceId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.padStart(32, "0");
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function normalizeTraceBody(body: StoredTraceBody): StoredTraceBody {
  return {
    ...body,
    method: normalizeHttpMethod(body.method),
    url: normalizeHttpUrl(body.url)
  };
}

function traceBodyMatchesSpan(
  body: StoredTraceBody,
  attributes: Record<string, unknown>
): boolean {
  const spanUrl = normalizeHttpUrl(
    toStringAttribute(attributes["http.url"]) ??
      toStringAttribute(attributes["url.full"])
  );

  if (body.url && (!spanUrl || body.url !== spanUrl)) {
    return false;
  }

  const spanMethod = normalizeHttpMethod(
    toStringAttribute(attributes["http.method"])
  );

  if (body.method && spanMethod && body.method !== spanMethod) {
    return false;
  }

  return true;
}
