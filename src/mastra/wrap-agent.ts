import { randomUUID } from "node:crypto";

import { trace } from "@opentelemetry/api";

import {
  clearPendingApproval,
  getPendingApproval,
  markActivityApproved
} from "../governance/approval-registry.js";
import {
  normalizeSpansForGovernance,
  serializeValue
} from "../governance/activity-runtime.js";
import { runWithOpenBoxExecutionContext } from "../governance/context.js";
import type { GovernanceVerdictResponse } from "../types/index.js";
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceAPIError,
  GovernanceHaltError,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "../types/index.js";
import type { WrapToolOptions } from "./wrap-tool.js";

const OPENBOX_WRAPPED_AGENT = Symbol.for("openbox.mastra.wrapAgent");
const OPENBOX_AGENT_STREAM_META = Symbol.for("openbox.mastra.wrapAgent.streamMeta");
const AGENT_INPUT_SIGNAL_NAME = "user_input";
const AGENT_OUTPUT_SIGNAL_NAME = "agent_output";
const OPENBOX_AGENT_RUN_GOALS = new Map<string, string>();
const OPENBOX_AGENT_SIGNAL_SPAN_CURSOR = new Map<string, number>();
const MAX_AGENT_OUTPUT_SIGNAL_SPANS = 8;
const MAX_AGENT_SIGNAL_SPAN_BODY_CHARS = 12_000;

interface AgentStreamMeta {
  startTimeMs: number;
}

interface AgentModelInfo {
  modelId?: string;
  provider?: string;
}

interface ParsedModelIdentifier {
  modelId?: string;
  provider?: string;
}

async function resolveAgentGoal(
  baseAgent: Record<PropertyKey, unknown> & {
    getInstructions?: (options?: { requestContext?: unknown }) => unknown;
  },
  executionOptions: Record<string, unknown> = {},
  interactionPayload?: unknown
): Promise<string | undefined> {
  const configuredGoal = normalizeGoalCandidate(process.env.OPENBOX_AGENT_GOAL);

  if (configuredGoal) {
    return configuredGoal;
  }

  const runIdCandidate =
    executionOptions &&
    typeof executionOptions === "object" &&
    "runId" in executionOptions
      ? (executionOptions as { runId?: unknown }).runId
      : undefined;
  const runId =
    typeof runIdCandidate === "string" && runIdCandidate.trim().length > 0
      ? runIdCandidate
      : undefined;
  const persistedGoal = runId ? OPENBOX_AGENT_RUN_GOALS.get(runId) : undefined;

  if (persistedGoal) {
    return persistedGoal;
  }

  const interactionGoal = normalizeGoalCandidate(
    extractGoalCandidateFromInteraction(interactionPayload)
  );

  if (interactionGoal) {
    return interactionGoal;
  }

  const getInstructions = baseAgent.getInstructions;

  if (typeof getInstructions !== "function") {
    return undefined;
  }

  try {
    const requestContext =
      executionOptions &&
      typeof executionOptions === "object" &&
      "requestContext" in executionOptions
        ? (executionOptions as { requestContext?: unknown }).requestContext
        : undefined;
    const instructions = await Promise.resolve(
      requestContext !== undefined
        ? getInstructions.call(baseAgent, { requestContext })
        : getInstructions.call(baseAgent)
    );

    return normalizeGoalCandidate(instructions);
  } catch {
    return undefined;
  }
}

function normalizeGoalCandidate(value: unknown): string | undefined {
  const text = extractTextFromStructuredValue(value);

  if (!text) {
    return undefined;
  }

  const normalized = text.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return truncateString(normalized, 1_000);
}

function extractGoalCandidateFromInteraction(value: unknown): string | undefined {
  const latestUserPrompt = extractLatestUserPrompt(value);

  if (latestUserPrompt) {
    return latestUserPrompt;
  }

  return extractTextFromStructuredValue(value);
}

export function wrapAgent<TAgent>(agent: TAgent, options: WrapToolOptions): TAgent {
  const baseAgent = agent as Record<PropertyKey, unknown> & {
    generate?: (messages: unknown, options?: Record<string, unknown>) => Promise<any>;
    getInstructions?: (options?: { requestContext?: unknown }) => unknown;
    id?: string;
    name?: string;
    resumeGenerate?: (
      resumeData: unknown,
      options?: Record<string, unknown>
    ) => Promise<any>;
    resumeStream?: (
      resumeData: unknown,
      options?: Record<string, unknown>
    ) => Promise<any>;
    stream?: (messages: unknown, options?: Record<string, unknown>) => Promise<any>;
  };

  if (baseAgent[OPENBOX_WRAPPED_AGENT]) {
    return agent;
  }

  const workflowType = String(baseAgent.id ?? baseAgent.name ?? "agent");
  const workflowId = `agent:${workflowType}`;
  const originalGenerate = baseAgent.generate?.bind(baseAgent);
  const originalStream = baseAgent.stream?.bind(baseAgent);
  const originalResumeGenerate = baseAgent.resumeGenerate?.bind(baseAgent);
  const originalResumeStream = baseAgent.resumeStream?.bind(baseAgent);

  if (originalGenerate) {
    baseAgent.generate = async (messages, executionOptions = {}) => {
      const runId = String(executionOptions.runId ?? randomUUID());
      const agentGoal = await resolveAgentGoal(
        baseAgent,
        executionOptions,
        messages
      );
      const nextOptions = {
        ...executionOptions,
        runId
      };
      const invocationModelInfo = resolveInvocationModelInfo(
        baseAgent,
        executionOptions
      );

      return executeAgentLifecycle(
        {
          messages,
          operation: () => originalGenerate(messages, nextOptions),
          options,
          phase: "start",
          runId,
          workflowId,
          workflowType,
          defaultModelInfo: invocationModelInfo,
          ...(agentGoal ? { agentGoal } : {})
        }
      );
    };
  }

  if (originalStream) {
    baseAgent.stream = async (messages, executionOptions = {}) => {
      const runId = String(executionOptions.runId ?? randomUUID());
      const agentGoal = await resolveAgentGoal(
        baseAgent,
        executionOptions,
        messages
      );
      const nextOptions = {
        ...executionOptions,
        runId
      };
      const invocationModelInfo = resolveInvocationModelInfo(
        baseAgent,
        executionOptions
      );
      const output = await executeAgentLifecycle(
        {
          messages,
          operation: () => originalStream(messages, nextOptions),
          options,
          phase: "start",
          runId,
          workflowId,
          workflowType,
          defaultModelInfo: invocationModelInfo,
          ...(agentGoal ? { agentGoal } : {})
        }
      );

      if (output && typeof output === "object") {
        const streamMeta = getAgentStreamMeta(output);
        attachStreamLifecycleHandlers(output, {
          onFailure: async error => {
            await sendAgentFailure(
              options,
              runId,
              workflowId,
              workflowType,
              error,
              streamMeta,
              agentGoal
            );
          },
          onSuccess: async fullOutput => {
            await finalizeAgentSuccess(
              options,
              runId,
              workflowId,
              workflowType,
              fullOutput,
              streamMeta,
              invocationModelInfo,
              agentGoal
            );
          }
        });
      }

      return output;
    };
  }

  if (originalResumeGenerate) {
    baseAgent.resumeGenerate = async (resumeData, executionOptions = {}) => {
      const runId = executionOptions.runId ? String(executionOptions.runId) : undefined;
      const agentGoal = await resolveAgentGoal(baseAgent, executionOptions);

      await handleAgentResume(
        options,
        runId,
        workflowId,
        workflowType,
        resumeData,
        agentGoal
      );
      const invocationModelInfo = resolveInvocationModelInfo(
        baseAgent,
        executionOptions
      );

      return executeAgentLifecycle({
        operation: () => originalResumeGenerate(resumeData, executionOptions),
        options,
        phase: "resume",
        runId: runId ?? randomUUID(),
        workflowId,
        workflowType,
        defaultModelInfo: invocationModelInfo,
        ...(agentGoal ? { agentGoal } : {})
      });
    };
  }

  if (originalResumeStream) {
    baseAgent.resumeStream = async (resumeData, executionOptions = {}) => {
      const runId = executionOptions.runId ? String(executionOptions.runId) : undefined;
      const resolvedRunId = runId ?? randomUUID();
      const agentGoal = await resolveAgentGoal(baseAgent, executionOptions);

      await handleAgentResume(
        options,
        runId,
        workflowId,
        workflowType,
        resumeData,
        agentGoal
      );
      const invocationModelInfo = resolveInvocationModelInfo(
        baseAgent,
        executionOptions
      );

      const output = await executeAgentLifecycle({
        operation: () => originalResumeStream(resumeData, executionOptions),
        options,
        phase: "resume",
        runId: resolvedRunId,
        workflowId,
        workflowType,
        defaultModelInfo: invocationModelInfo,
        ...(agentGoal ? { agentGoal } : {})
      });

      if (output && typeof output === "object") {
        const streamMeta = getAgentStreamMeta(output);
        attachStreamLifecycleHandlers(output, {
          onFailure: async error => {
            await sendAgentFailure(
              options,
              resolvedRunId,
              workflowId,
              workflowType,
              error,
              streamMeta,
              agentGoal
            );
          },
          onSuccess: async fullOutput => {
            await finalizeAgentSuccess(
              options,
              resolvedRunId,
              workflowId,
              workflowType,
              fullOutput,
              streamMeta,
              invocationModelInfo,
              agentGoal
            );
          }
        });
      }

      return output;
    };
  }

  Object.defineProperty(baseAgent, OPENBOX_WRAPPED_AGENT, {
    enumerable: false,
    value: true
  });

  return agent;
}

async function executeAgentLifecycle<T>({
  messages,
  operation,
  options,
  phase,
  runId,
  workflowId,
  workflowType,
  defaultModelInfo,
  agentGoal
}: {
  messages?: unknown;
  operation: () => Promise<T>;
  options: WrapToolOptions;
  phase: "resume" | "start";
  runId: string;
  workflowId: string;
  workflowType: string;
  defaultModelInfo: AgentModelInfo;
  agentGoal?: string;
}): Promise<T> {
  const effectiveGoal =
    agentGoal ?? normalizeGoalCandidate(extractGoalCandidateFromInteraction(messages));

  if (effectiveGoal) {
    OPENBOX_AGENT_RUN_GOALS.set(runId, effectiveGoal);
  }

  if (
    phase === "start" &&
    !options.config.skipWorkflowTypes.has(workflowType) &&
    options.config.sendStartEvent
  ) {
    const verdict = await evaluateAgentEvent(options, {
      event_type: WorkflowEventType.WORKFLOW_STARTED,
      ...(effectiveGoal ? { goal: effectiveGoal } : {}),
      run_id: runId,
      task_queue: "mastra",
      workflow_id: workflowId,
      workflow_input: serializeWorkflowInputForGovernance(
        messages,
        effectiveGoal
      ),
      workflow_type: workflowType
    });

    if (verdict && Verdict.shouldStop(verdict.verdict)) {
      throw new GovernanceHaltError(
        verdict.reason ?? "Agent blocked by governance"
      );
    }
  }

  if (
    phase === "start" &&
    messages !== undefined &&
    !options.config.skipWorkflowTypes.has(workflowType) &&
    !options.config.skipSignals.has(AGENT_INPUT_SIGNAL_NAME)
  ) {
    const verdict = await evaluateAgentEvent(options, {
      event_type: WorkflowEventType.SIGNAL_RECEIVED,
      ...(effectiveGoal ? { goal: effectiveGoal } : {}),
      run_id: runId,
      signal_args: serializeAgentSignalArgs(messages, effectiveGoal),
      signal_name: AGENT_INPUT_SIGNAL_NAME,
      task_queue: "mastra",
      workflow_id: workflowId,
      workflow_type: workflowType
    });

    if (verdict && Verdict.shouldStop(verdict.verdict)) {
      throw new GovernanceHaltError(
        verdict.reason ?? "Agent blocked by governance"
      );
    }
  }

  ensureAgentSpanBuffer(options, runId, workflowId, workflowType);
  const startTimeMs = Date.now();

  return runWithOpenBoxExecutionContext(
    {
      agentId: workflowType,
      ...(effectiveGoal ? { goal: effectiveGoal } : {}),
      runId,
      source: "agent",
      taskQueue: "mastra",
      workflowId,
      workflowType
    },
    async () => {
      try {
        const result = await trace
          .getTracer("openbox.mastra")
          .startActiveSpan(`agent.${phase}.${workflowType}`, async activeSpan => {
            activeSpan.setAttribute("openbox.workflow_id", workflowId);
            activeSpan.setAttribute("openbox.activity_id", `agent:${workflowType}:${phase}`);
            activeSpan.setAttribute("openbox.run_id", runId);
            options.spanProcessor.registerTrace(
              activeSpan.spanContext().traceId,
              workflowId,
              `agent:${workflowType}:${phase}`,
              runId
            );

            try {
              return await operation();
            } finally {
              activeSpan.end();
            }
          });
        const isStreamResult =
          result != null &&
          typeof result === "object" &&
          ("getFullOutput" in (result as Record<string, unknown>) ||
            "fullStream" in (result as Record<string, unknown>));

        if (
          !isStreamResult
        ) {
          const finishReason =
            result != null && typeof result === "object"
              ? (result as { finishReason?: unknown }).finishReason
              : undefined;

          if (finishReason === "suspended") {
            return result;
          }

          await finalizeAgentSuccess(
            options,
            runId,
            workflowId,
            workflowType,
            result,
            {
              startTimeMs
            },
            defaultModelInfo,
            effectiveGoal
          );
        }

        if (isStreamResult) {
          setAgentStreamMeta(result as Record<PropertyKey, unknown>, {
            startTimeMs
          });
        }

        return result;
      } catch (error) {
        await sendAgentFailure(
          options,
          runId,
          workflowId,
          workflowType,
          error,
          {
            startTimeMs
          },
          effectiveGoal
        );
        throw error;
      }
    }
  );
}

async function handleAgentResume(
  options: WrapToolOptions,
  runId: string | undefined,
  workflowId: string,
  workflowType: string,
  resumeData: unknown,
  agentGoal?: string
): Promise<void> {
  if (!runId) {
    return;
  }

  const effectiveGoal = agentGoal ?? OPENBOX_AGENT_RUN_GOALS.get(runId);

  if (effectiveGoal) {
    OPENBOX_AGENT_RUN_GOALS.set(runId, effectiveGoal);
  }

  if (
    !options.config.skipWorkflowTypes.has(workflowType) &&
    !options.config.skipSignals.has("resume")
  ) {
    const verdict = await evaluateAgentEvent(options, {
      event_type: WorkflowEventType.SIGNAL_RECEIVED,
      ...(effectiveGoal ? { goal: effectiveGoal } : {}),
      run_id: runId,
      signal_args: appendGoalToSignalArgs(
        serializeValue(resumeData),
        effectiveGoal
      ),
      signal_name: "resume",
      task_queue: "mastra",
      workflow_id: workflowId,
      workflow_type: workflowType
    });

    if (verdict && Verdict.shouldStop(verdict.verdict)) {
      throw new GovernanceHaltError(
        verdict.reason ?? "Agent blocked by governance"
      );
    }
  }

  const pending = getPendingApproval(runId);

  if (!pending) {
    return;
  }

  const approval = await options.client.pollApproval({
    activityId: pending.activityId,
    runId: pending.runId,
    workflowId: pending.workflowId
  });

  if (!approval) {
    throw new ApprovalPendingError("Failed to check approval status, retrying...");
  }

  if (approval.expired) {
    clearPendingApproval(runId);
    throw new ApprovalExpiredError(
      `Approval expired for activity ${pending.activityType}`
    );
  }

  const verdict = Verdict.fromString(
    (approval.verdict as string | undefined) ??
      (approval.action as string | undefined)
  );

  if (verdict === Verdict.ALLOW) {
    markActivityApproved(pending.runId, pending.activityId);
    clearPendingApproval(runId);
    return;
  }

  if (Verdict.shouldStop(verdict)) {
    clearPendingApproval(runId);
    throw new ApprovalRejectedError(
      `Activity rejected: ${String(approval.reason ?? "Activity rejected")}`
    );
  }

  throw new ApprovalPendingError(
    `Awaiting approval for activity ${pending.activityType}`
  );
}

async function finalizeAgentSuccess(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string,
  output: unknown,
  streamMeta?: AgentStreamMeta,
  defaultModelInfo: AgentModelInfo = {},
  agentGoal?: string
): Promise<void> {
  if (options.config.skipWorkflowTypes.has(workflowType)) {
    clearAgentRunState(runId);
    return;
  }
  try {
    await emitAgentOutputSignal(
      options,
      runId,
      workflowId,
      workflowType,
      output,
      agentGoal
    );

    const workflowSpans = normalizeSpansForGovernance(
      options.spanProcessor.getBuffer(workflowId, runId)?.spans ?? []
    );
    const modelInfo = resolveWorkflowModelInfo(
      output,
      defaultModelInfo,
      workflowSpans
    );
    const resolvedOutput = applyDefaultModelInfo(output, modelInfo);
    const basePayload = {
      event_type: WorkflowEventType.WORKFLOW_COMPLETED,
      ...(agentGoal ? { goal: agentGoal } : {}),
      run_id: runId,
      workflow_id: workflowId,
      workflow_type: workflowType
    } as const;
    const workflowOutput = serializeWorkflowOutputForGovernance(resolvedOutput);
    const telemetryPayload = buildWorkflowCompletedTelemetryPayload(
      {
        ...basePayload,
        workflow_output: workflowOutput
      },
      resolvedOutput,
      workflowSpans,
      modelInfo,
      streamMeta,
    );
    const compactPayload = buildWorkflowCompletedCompactPayload(
      basePayload,
      workflowOutput,
      resolvedOutput,
      modelInfo,
      streamMeta,
    );
    const ultraMinimalPayload = buildWorkflowCompletedUltraMinimalPayload(
      basePayload,
      resolvedOutput,
      modelInfo,
      streamMeta,
    );

    const verdict = await evaluateAgentEvent(
      options,
      telemetryPayload,
      compactPayload,
      ultraMinimalPayload
    );

    if (verdict && Verdict.shouldStop(verdict.verdict)) {
      throw new GovernanceHaltError(
        verdict.reason ?? "Agent blocked by governance"
      );
    }
  } finally {
    clearAgentRunState(runId);
  }
}

function buildWorkflowCompletedCompactPayload(
  basePayload: {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED;
    run_id: string;
    workflow_id: string;
    workflow_type: string;
  },
  workflowOutput: unknown,
  output: unknown,
  modelInfo: AgentModelInfo,
  streamMeta?: AgentStreamMeta
): Record<string, unknown> & { event_type: WorkflowEventType } {
  const endTimeMs = Date.now();
  const startTimeMs = streamMeta?.startTimeMs;
  const durationMs =
    typeof startTimeMs === "number" ? Math.max(0, endTimeMs - startTimeMs) : undefined;
  const usage = extractUsageMetrics(output);
  const telemetryModelId = toTelemetryModelId(modelInfo.modelId);
  const syntheticSpans = buildWorkflowTelemetrySpans(
    [],
    modelInfo,
    usage,
    endTimeMs
  );

  const payload: Record<string, unknown> & {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED;
  } = {
    event_type: basePayload.event_type,
    run_id: basePayload.run_id,
    workflow_id: basePayload.workflow_id,
    workflow_type: basePayload.workflow_type,
    ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}),
    ...(typeof startTimeMs === "number" ? { start_time: startTimeMs } : {}),
    end_time: endTimeMs,
    ...(typeof usage.inputTokens === "number"
      ? { input_tokens: usage.inputTokens }
      : {}),
    ...(typeof usage.outputTokens === "number"
      ? { output_tokens: usage.outputTokens }
      : {}),
    ...(typeof usage.totalTokens === "number"
      ? { total_tokens: usage.totalTokens }
      : {}),
    ...(modelInfo.modelId ? { model_id: modelInfo.modelId } : {}),
    ...(telemetryModelId ? { model: telemetryModelId } : {}),
    ...(modelInfo.provider ? { model_provider: modelInfo.provider } : {}),
    ...(modelInfo.provider ? { provider: modelInfo.provider } : {}),
    ...(syntheticSpans.length > 0
      ? {
          span_count: syntheticSpans.length,
          spans: syntheticSpans
        }
      : {
          span_count: 0
        })
  };
  const compactOutput = compactWorkflowOutput(workflowOutput);

  if (compactOutput !== undefined) {
    payload.workflow_output = compactOutput;
  }

  return payload;
}

function buildWorkflowCompletedUltraMinimalPayload(
  basePayload: {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED;
    run_id: string;
    workflow_id: string;
    workflow_type: string;
  },
  output: unknown,
  modelInfo: AgentModelInfo,
  streamMeta?: AgentStreamMeta
): Record<string, unknown> & { event_type: WorkflowEventType } {
  const endTimeMs = Date.now();
  const startTimeMs = streamMeta?.startTimeMs;
  const durationMs =
    typeof startTimeMs === "number" ? Math.max(0, endTimeMs - startTimeMs) : undefined;
  const usage = extractUsageMetrics(output);
  const telemetryModelId = toTelemetryModelId(modelInfo.modelId);

  return {
    ...basePayload,
    ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}),
    ...(typeof startTimeMs === "number" ? { start_time: startTimeMs } : {}),
    end_time: endTimeMs,
    ...(typeof usage.inputTokens === "number"
      ? { input_tokens: usage.inputTokens }
      : {}),
    ...(typeof usage.outputTokens === "number"
      ? { output_tokens: usage.outputTokens }
      : {}),
    ...(typeof usage.totalTokens === "number"
      ? { total_tokens: usage.totalTokens }
      : {}),
    ...(modelInfo.modelId ? { model_id: modelInfo.modelId } : {}),
    ...(telemetryModelId ? { model: telemetryModelId } : {}),
    ...(modelInfo.provider ? { model_provider: modelInfo.provider } : {}),
    ...(modelInfo.provider ? { provider: modelInfo.provider } : {})
  };
}

function buildWorkflowCompletedTelemetryPayload(
  basePayload: {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED;
    run_id: string;
    workflow_id: string;
    workflow_output: unknown;
    workflow_type: string;
  },
  output: unknown,
  workflowSpans: Array<Record<string, unknown>>,
  modelInfo: AgentModelInfo,
  streamMeta?: AgentStreamMeta
): Record<string, unknown> & { event_type: WorkflowEventType } {
  const endTimeMs = Date.now();
  const startTimeMs = streamMeta?.startTimeMs;
  const durationMs =
    typeof startTimeMs === "number" ? Math.max(0, endTimeMs - startTimeMs) : undefined;
  const usage = extractUsageMetrics(output);
  const telemetryModelId = toTelemetryModelId(modelInfo.modelId);
  const spans = buildWorkflowTelemetrySpans(
    workflowSpans,
    modelInfo,
    usage,
    endTimeMs
  );

  return {
    ...basePayload,
    ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}),
    ...(typeof startTimeMs === "number" ? { start_time: startTimeMs } : {}),
    end_time: endTimeMs,
    ...(typeof usage.inputTokens === "number"
      ? { input_tokens: usage.inputTokens }
      : {}),
    ...(typeof usage.outputTokens === "number"
      ? { output_tokens: usage.outputTokens }
      : {}),
    ...(typeof usage.totalTokens === "number"
      ? { total_tokens: usage.totalTokens }
      : {}),
    ...(modelInfo.modelId ? { model_id: modelInfo.modelId } : {}),
    ...(telemetryModelId ? { model: telemetryModelId } : {}),
    ...(modelInfo.provider ? { model_provider: modelInfo.provider } : {}),
    ...(modelInfo.provider ? { provider: modelInfo.provider } : {}),
    span_count: spans.length,
    spans
  };
}

function extractUsageMetrics(output: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const outputRecord =
    output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  const usageCandidates = [
    outputRecord?.usage,
    outputRecord?.totalUsage,
    outputRecord?.output,
    outputRecord?.stepResult
  ];

  for (const candidate of usageCandidates) {
    const usage = extractUsageRecord(candidate);

    if (usage) {
      return usage;
    }
  }

  return {};
}

function extractUsageRecord(value: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usage = "usage" in record && record.usage && typeof record.usage === "object"
    ? (record.usage as Record<string, unknown>)
    : record;
  const inputTokens = toNumber(usage.inputTokens);
  const outputTokens = toNumber(usage.outputTokens);
  const totalTokens = toNumber(usage.totalTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function serializeWorkflowOutputForGovernance(output: unknown): unknown {
  const serialized = serializeValue(output);
  return compactWorkflowOutput(serialized) ?? {
    summary: "Workflow output omitted by SDK compaction"
  };
}

function serializeWorkflowInputForGovernance(
  input: unknown,
  goal: string | undefined
): unknown {
  const serializedInput = serializeValue(input);
  const prompt = extractLatestUserPrompt(input);

  if (!goal && prompt === undefined) {
    return serializedInput;
  }

  return {
    ...(goal ? { goal } : {}),
    ...(prompt ? { prompt } : {}),
    input: serializedInput
  };
}

function compactWorkflowOutput(output: unknown): unknown {
  if (output == null) {
    return output;
  }

  if (typeof output === "string") {
    return truncateString(output, 4_000);
  }

  if (typeof output !== "object") {
    return output;
  }

  const record = output as Record<string, unknown>;
  const usage = extractUsageMetrics(output);
  const compact: Record<string, unknown> = {
    ...(typeof record.finishReason === "string"
      ? { finishReason: record.finishReason }
      : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.text === "string"
      ? { text: truncateString(record.text, 4_000) }
      : {}),
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    ...(typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number" ||
    typeof usage.totalTokens === "number"
      ? {
          usage: {
            ...(typeof usage.inputTokens === "number"
              ? { inputTokens: usage.inputTokens }
              : {}),
            ...(typeof usage.outputTokens === "number"
              ? { outputTokens: usage.outputTokens }
              : {}),
            ...(typeof usage.totalTokens === "number"
              ? { totalTokens: usage.totalTokens }
              : {})
          }
        }
      : {})
  };
  const warnings = record.warnings;

  if (Array.isArray(warnings) && warnings.length > 0) {
    compact.warnings = warnings.slice(0, 3).map(warning => serializeValue(warning));
  }

  if (Object.keys(compact).length > 0) {
    return compact;
  }

  const fallback = JSON.stringify(record);
  return truncateString(fallback, 4_000);
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
}

function serializeAgentSignalArgs(
  messages: unknown,
  goal?: string
): unknown {
  const latestUserPrompt = extractLatestUserPrompt(messages);

  if (latestUserPrompt) {
    return appendGoalToSignalArgs([latestUserPrompt], goal);
  }

  const serialized = serializeValue(messages);

  if (serialized == null) {
    return appendGoalToSignalArgs([], goal);
  }

  return appendGoalToSignalArgs(
    Array.isArray(serialized) ? serialized : [serialized],
    goal
  );
}

function serializeAgentOutputSignalArgs(
  output: unknown,
  goal?: string
): unknown[] {
  const serialized = compactWorkflowOutput(serializeValue(output));

  if (serialized === undefined || serialized === null) {
    return appendGoalToSignalArgs([], goal);
  }

  return appendGoalToSignalArgs(
    Array.isArray(serialized) ? serialized : [serialized],
    goal
  );
}

function appendGoalToSignalArgs(
  signalArgs: unknown,
  goal: string | undefined
): unknown[] {
  const normalizedArgs = Array.isArray(signalArgs)
    ? [...signalArgs]
    : signalArgs === undefined || signalArgs === null
      ? []
      : [signalArgs];

  if (!goal || goal.trim().length === 0) {
    return normalizedArgs;
  }

  const trimmedGoal = goal.trim();

  if (trimmedGoal.length === 0) {
    return normalizedArgs;
  }

  if (normalizedArgs.length === 0) {
    return [{ goal: trimmedGoal }];
  }

  const hasGoalObject = normalizedArgs.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }

    const existingGoal = (item as Record<string, unknown>).goal;
    return typeof existingGoal === "string" && existingGoal.trim().length > 0;
  });

  if (hasGoalObject) {
    return normalizedArgs;
  }

  const firstPrompt =
    typeof normalizedArgs[0] === "string"
      ? (normalizedArgs[0] as string).trim()
      : "";

  if (firstPrompt.length > 0) {
    return [...normalizedArgs, { goal: trimmedGoal, prompt: firstPrompt }];
  }

  return [...normalizedArgs, { goal: trimmedGoal }];
}

function extractLatestUserPrompt(messages: unknown): string | undefined {
  const candidates = normalizeMessageCandidates(messages);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];

    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role.toLowerCase() : undefined;

    if (role && role !== "user") {
      continue;
    }

    const text =
      extractTextFromStructuredValue(record.content) ??
      extractTextFromStructuredValue(record.parts) ??
      extractTextFromStructuredValue(record.prompt) ??
      extractTextFromStructuredValue(record.input);

    if (text) {
      return text;
    }
  }

  return undefined;
}

function normalizeMessageCandidates(messages: unknown): unknown[] {
  if (Array.isArray(messages)) {
    return messages;
  }

  if (!messages || typeof messages !== "object") {
    return [];
  }

  const record = messages as Record<string, unknown>;
  return Array.isArray(record.messages) ? record.messages : [];
}

function extractTextFromStructuredValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return undefined;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const extracted = extractTextFromStructuredValue(parsed);

        if (extracted && extracted.trim().length > 0) {
          return extracted.trim();
        }
      } catch {
        // Preserve original string when JSON parsing fails.
      }
    }

    return trimmed;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(item => extractTextFromStructuredValue(item))
      .filter((item): item is string => typeof item === "string" && item.length > 0);

    if (parts.length === 0) {
      return undefined;
    }

    const combined = parts.join("\n").trim();
    return combined.length > 0 ? combined : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const text =
    extractTextFromStructuredValue(record.text) ??
    extractTextFromStructuredValue(record.content) ??
    extractTextFromStructuredValue(record.parts) ??
    extractTextFromStructuredValue(record.prompt) ??
    extractTextFromStructuredValue(record.input) ??
    extractTextFromStructuredValue(record.messages);

  if (!text) {
    return undefined;
  }

  return text.trim().length > 0 ? text.trim() : undefined;
}

function extractModelInfo(
  output: unknown,
  fallback: AgentModelInfo = {}
): {
  modelId?: string;
  provider?: string;
} {
  if (!output || typeof output !== "object") {
    return {
      ...(fallback.modelId ? { modelId: fallback.modelId } : {}),
      ...(fallback.provider ? { provider: fallback.provider } : {})
    };
  }

  const record = output as Record<string, unknown>;
  const response =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const modelMetadata =
    response?.modelMetadata && typeof response.modelMetadata === "object"
      ? (response.modelMetadata as Record<string, unknown>)
      : undefined;
  const parsedModelInfo = resolveModelInfoFromCandidates([
    response?.modelId,
    modelMetadata?.modelId,
    response?.model,
    record.modelId,
    record.model
  ]);
  const providerCandidates = [
    modelMetadata?.provider,
    response?.provider,
    record.provider,
    parsedModelInfo.provider,
    extractProviderHint(record)
  ];
  const modelId: string | undefined = parsedModelInfo.modelId;
  let provider: string | undefined;

  for (const candidate of providerCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      provider = normalizeProvider(candidate);
      break;
    }
  }

  return {
    ...(modelId ? { modelId } : {}),
    ...(!modelId && fallback.modelId ? { modelId: fallback.modelId } : {}),
    ...(provider ? { provider } : {}),
    ...(!provider && fallback.provider ? { provider: fallback.provider } : {})
  };
}

function extractAgentModelInfo(
  agentRecord: Record<PropertyKey, unknown>
): AgentModelInfo {
  const directModelInfo = resolveModelInfoFromCandidates([agentRecord.model]);
  const model =
    agentRecord.model && typeof agentRecord.model === "object"
      ? (agentRecord.model as Record<string, unknown>)
      : undefined;
  const config =
    model?.config && typeof model.config === "object"
      ? (model.config as Record<string, unknown>)
      : undefined;
  const nestedModelInfo = resolveModelInfoFromCandidates([
    model?.modelId,
    config?.modelId,
    model?.id,
    model?.name,
    model?.model
  ]);
  const providerCandidates = [
    nestedModelInfo.provider,
    config?.provider,
    model?.provider,
    directModelInfo.provider
  ];
  const modelId: string | undefined =
    directModelInfo.modelId ?? nestedModelInfo.modelId;
  let provider: string | undefined;

  for (const candidate of providerCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      provider = normalizeProvider(candidate);
      break;
    }
  }

  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {})
  };
}

function resolveInvocationModelInfo(
  agentRecord: Record<PropertyKey, unknown>,
  executionOptions: Record<string, unknown>
): AgentModelInfo {
  const agentModelInfo = extractAgentModelInfo(agentRecord);
  const optionsModelInfo = extractModelInfo(executionOptions, {});

  return {
    ...(optionsModelInfo.modelId
      ? { modelId: optionsModelInfo.modelId }
      : agentModelInfo.modelId
        ? { modelId: agentModelInfo.modelId }
        : {}),
    ...(optionsModelInfo.provider
      ? { provider: optionsModelInfo.provider }
      : agentModelInfo.provider
        ? { provider: agentModelInfo.provider }
        : {})
  };
}

function applyDefaultModelInfo(
  output: unknown,
  fallback: AgentModelInfo
): unknown {
  if (!output || typeof output !== "object") {
    return output;
  }

  const record = output as Record<string, unknown>;
  const hasModelId =
    typeof record.modelId === "string" &&
    (record.modelId as string).trim().length > 0;
  const hasProvider =
    typeof record.provider === "string" &&
    (record.provider as string).trim().length > 0;

  if ((hasModelId || !fallback.modelId) && (hasProvider || !fallback.provider)) {
    return output;
  }

  return {
    ...record,
    ...(!hasModelId && fallback.modelId ? { modelId: fallback.modelId } : {}),
    ...(!hasProvider && fallback.provider ? { provider: fallback.provider } : {})
  };
}

function extractProviderHint(
  outputRecord: Record<string, unknown>
): string | undefined {
  const parsedModelInfo = resolveModelInfoFromCandidates([
    outputRecord.modelId,
    outputRecord.model
  ]);

  if (parsedModelInfo.provider) {
    return parsedModelInfo.provider;
  }

  const directProvider = inferProviderFromMetadata(outputRecord.providerMetadata);

  if (directProvider) {
    return directProvider;
  }

  const toolCallsProvider = inferProviderFromToolCalls(outputRecord.toolCalls);

  if (toolCallsProvider) {
    return toolCallsProvider;
  }

  const steps = Array.isArray(outputRecord.steps)
    ? outputRecord.steps
    : undefined;

  if (!steps) {
    return undefined;
  }

  for (const step of steps) {
    if (!step || typeof step !== "object") {
      continue;
    }

    const stepRecord = step as Record<string, unknown>;
    const stepProvider = inferProviderFromMetadata(stepRecord.providerMetadata);

    if (stepProvider) {
      return stepProvider;
    }

    const stepToolProvider = inferProviderFromToolCalls(stepRecord.toolCalls);

    if (stepToolProvider) {
      return stepToolProvider;
    }
  }

  return undefined;
}

function inferProviderFromToolCalls(toolCalls: unknown): string | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  for (const entry of toolCalls) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const entryRecord = entry as Record<string, unknown>;
    const directProvider = inferProviderFromMetadata(entryRecord.providerMetadata);

    if (directProvider) {
      return directProvider;
    }

    const payload =
      entryRecord.payload && typeof entryRecord.payload === "object"
        ? (entryRecord.payload as Record<string, unknown>)
        : undefined;
    const payloadProvider = inferProviderFromMetadata(payload?.providerMetadata);

    if (payloadProvider) {
      return payloadProvider;
    }
  }

  return undefined;
}

function inferProviderFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const keys = Object.keys(metadata as Record<string, unknown>).map(key =>
    key.toLowerCase()
  );

  if (keys.includes("openai")) {
    return "openai";
  }

  if (keys.includes("anthropic")) {
    return "anthropic";
  }

  if (keys.includes("google") || keys.includes("gemini")) {
    return "google";
  }

  return undefined;
}

function resolveModelInfoFromCandidates(
  candidates: unknown[]
): ParsedModelIdentifier {
  let modelId: string | undefined;
  let provider: string | undefined;

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }

    const parsed = parseModelIdentifier(candidate);

    if (!modelId && parsed.modelId) {
      modelId = parsed.modelId;
    }

    if (!provider && parsed.provider) {
      provider = parsed.provider;
    }

    if (modelId && provider) {
      break;
    }
  }

  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {})
  };
}

function parseModelIdentifier(candidate: string): ParsedModelIdentifier {
  const trimmed = candidate.trim();

  if (!trimmed) {
    return {};
  }

  const slashParts = trimmed.split("/");

  if (slashParts.length >= 2) {
    const possibleProvider = slashParts[0]?.trim();
    const modelPart = slashParts.slice(1).join("/").trim();

    if (possibleProvider && modelPart && isProviderToken(possibleProvider)) {
      return {
        modelId: modelPart,
        provider: normalizeProvider(possibleProvider)
      };
    }
  }

  return {
    modelId: trimmed
  };
}

function isProviderToken(candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();

  return (
    normalized.includes("openai") ||
    normalized.includes("anthropic") ||
    normalized.includes("google") ||
    normalized.includes("gemini")
  );
}

function normalizeProvider(candidate: string): string {
  const normalized = candidate.trim().toLowerCase();

  if (normalized.includes("openai")) {
    return "openai";
  }

  if (normalized.includes("anthropic")) {
    return "anthropic";
  }

  if (normalized.includes("google") || normalized.includes("gemini")) {
    return "google";
  }

  return candidate.trim();
}

function toTelemetryModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }

  const trimmed = modelId.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const sanitized = trimmed
    .replace(/[.:/\\\s]+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized.length > 0 ? sanitized : trimmed;
}

function buildWorkflowTelemetrySpans(
  spans: Array<Record<string, unknown>>,
  modelInfo: {
    modelId?: string;
    provider?: string;
  },
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  },
  endTimeMs: number
): Array<Record<string, unknown>> {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  if (inputTokens <= 0 && outputTokens <= 0) {
    return spans;
  }

  if (hasParseableModelUsageSpan(spans)) {
    return spans;
  }

  const providerUrl = resolveProviderUrl(modelInfo, spans);

  if (!providerUrl) {
    return spans;
  }
  const modelId = resolveSyntheticModelId(modelInfo, spans);

  const traceId = getTraceIdCandidate(spans);

  return [
    ...spans,
    createSyntheticModelUsageSpan({
      endTimeMs,
      inputTokens,
      modelId,
      outputTokens,
      providerUrl,
      ...(modelInfo.provider ? { provider: modelInfo.provider } : {}),
      ...(traceId ? { traceId } : {})
    })
  ];
}

function hasParseableModelUsageSpan(
  spans: Array<Record<string, unknown>>
): boolean {
  return spans.some(span => {
    const attributes =
      span.attributes && typeof span.attributes === "object"
        ? (span.attributes as Record<string, unknown>)
        : {};
    const rawUrl = attributes["http.url"] ?? attributes["url.full"];
    const url = typeof rawUrl === "string" ? rawUrl : undefined;

    if (!url || !isLlmProviderUrl(url)) {
      return false;
    }

    const responseBody = getStringField(span, "response_body", "responseBody");

    if (!responseBody) {
      return false;
    }

    if (!hasUsageInBody(responseBody)) {
      return false;
    }

    const modelFromResponse = extractModelIdFromBody(responseBody);

    if (modelFromResponse) {
      return true;
    }

    const requestBody = getStringField(span, "request_body", "requestBody");

    if (!requestBody) {
      return false;
    }

    return extractModelIdFromBody(requestBody) !== undefined;
  });
}

function hasUsageInBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      usage?: {
        completion_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
        prompt_tokens?: unknown;
      };
    };

    const usage = parsed.usage;
    return (
      typeof usage?.prompt_tokens === "number" ||
      typeof usage?.completion_tokens === "number" ||
      typeof usage?.input_tokens === "number" ||
      typeof usage?.output_tokens === "number"
    );
  } catch {
    return false;
  }
}

function extractModelIdFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    const model =
      typeof parsed.model === "string" ? parsed.model.trim() : undefined;

    return model && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

function createSyntheticModelUsageSpan({
  endTimeMs,
  inputTokens,
  modelId,
  outputTokens,
  provider,
  providerUrl,
  traceId
}: {
  endTimeMs: number;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  provider?: string;
  providerUrl: string;
  traceId?: string;
}): Record<string, unknown> {
  const endTimeNs = Math.max(1, Math.floor(endTimeMs * 1_000_000));
  const startTimeNs = Math.max(0, endTimeNs - 1);
  const normalizedTraceId = normalizeHexId(traceId, 32);
  const spanId = normalizeHexId(undefined, 16);
  const telemetryModelId = toTelemetryModelId(modelId) ?? modelId;

  return {
    attributes: {
      "http.method": "POST",
      "http.url": providerUrl,
      "openbox.synthetic": true
    },
    duration_ns: 1,
    end_time: endTimeNs,
    events: [],
    kind: "CLIENT",
    name: "openbox.synthetic.model_usage",
    request_body: JSON.stringify({
      model: telemetryModelId,
      model_id: modelId,
      ...(provider ? { model_provider: provider } : {}),
      ...(provider ? { provider } : {})
    }),
    response_body: JSON.stringify({
      model: telemetryModelId,
      model_id: modelId,
      ...(provider ? { model_provider: provider } : {}),
      ...(provider ? { provider } : {}),
      usage: {
        completion_tokens: outputTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        prompt_tokens: inputTokens,
        total_tokens: inputTokens + outputTokens
      }
    }),
    semantic_type: "llm_completion",
    span_id: spanId,
    start_time: startTimeNs,
    status: {
      code: "OK"
    },
    trace_id: normalizedTraceId
  };
}

function resolveProviderUrl(modelInfo: {
  modelId?: string;
  provider?: string;
}, spans: Array<Record<string, unknown>>): string | undefined {
  const provider = modelInfo.provider?.toLowerCase();
  const modelId = modelInfo.modelId?.toLowerCase();

  if (provider?.includes("openai")) {
    return "https://api.openai.com/v1/responses";
  }

  if (provider?.includes("anthropic")) {
    return "https://api.anthropic.com/v1/messages";
  }

  if (provider?.includes("google") || provider?.includes("gemini")) {
    return "https://generativelanguage.googleapis.com/v1beta/models";
  }

  for (const span of spans) {
    const attributes =
      span.attributes && typeof span.attributes === "object"
        ? (span.attributes as Record<string, unknown>)
        : {};
    const rawUrl = attributes["http.url"] ?? attributes["url.full"];
    const url = typeof rawUrl === "string" ? rawUrl : undefined;

    if (!url) {
      continue;
    }

    if (url.includes("api.openai.com")) {
      return "https://api.openai.com/v1/responses";
    }

    if (url.includes("api.anthropic.com")) {
      return "https://api.anthropic.com/v1/messages";
    }

    if (url.includes("generativelanguage.googleapis.com")) {
      return "https://generativelanguage.googleapis.com/v1beta/models";
    }
  }

  if (!modelId) {
    return undefined;
  }

  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3")
  ) {
    return "https://api.openai.com/v1/responses";
  }

  if (modelId.startsWith("claude-")) {
    return "https://api.anthropic.com/v1/messages";
  }

  if (modelId.startsWith("gemini")) {
    return "https://generativelanguage.googleapis.com/v1beta/models";
  }

  return undefined;
}

function resolveSyntheticModelId(
  modelInfo: {
    modelId?: string;
  },
  spans: Array<Record<string, unknown>>
): string {
  for (const span of spans) {
    const responseBody = getStringField(span, "response_body", "responseBody");

    if (responseBody) {
      const modelFromResponse = extractModelIdFromBody(responseBody);

      if (modelFromResponse) {
        return modelFromResponse;
      }
    }

    const requestBody = getStringField(span, "request_body", "requestBody");

    if (!requestBody) {
      continue;
    }

    const modelFromRequest = extractModelIdFromBody(requestBody);

    if (modelFromRequest) {
      return modelFromRequest;
    }
  }

  if (modelInfo.modelId) {
    return modelInfo.modelId;
  }

  return "unknown-model";
}

function getTraceIdCandidate(
  spans: Array<Record<string, unknown>>
): string | undefined {
  for (const span of spans) {
    const traceId = getStringField(span, "trace_id", "traceId");

    if (traceId) {
      return traceId;
    }
  }

  return undefined;
}

function getStringField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): string | undefined {
  const snake = record[snakeKey];

  if (typeof snake === "string") {
    return snake;
  }

  const camel = record[camelKey];

  if (typeof camel === "string") {
    return camel;
  }

  return undefined;
}

function isLlmProviderUrl(url: string): boolean {
  return (
    url.includes("api.openai.com") ||
    url.includes("api.anthropic.com") ||
    url.includes("generativelanguage.googleapis.com")
  );
}

function resolveWorkflowModelInfo(
  output: unknown,
  fallbackModelInfo: AgentModelInfo,
  spans: Array<Record<string, unknown>>
): AgentModelInfo {
  const outputModelInfo = extractModelInfo(output, {});
  const spanModelInfo = extractModelInfoFromSpans(spans);

  return {
    ...(outputModelInfo.modelId
      ? { modelId: outputModelInfo.modelId }
      : spanModelInfo.modelId
        ? { modelId: spanModelInfo.modelId }
        : fallbackModelInfo.modelId
          ? { modelId: fallbackModelInfo.modelId }
          : {}),
    ...(outputModelInfo.provider
      ? { provider: outputModelInfo.provider }
      : spanModelInfo.provider
        ? { provider: spanModelInfo.provider }
        : fallbackModelInfo.provider
          ? { provider: fallbackModelInfo.provider }
          : {})
  };
}

function extractModelInfoFromSpans(
  spans: Array<Record<string, unknown>>
): AgentModelInfo {
  let modelId: string | undefined;
  let provider: string | undefined;

  for (const span of spans) {
    const attributes =
      span.attributes && typeof span.attributes === "object"
        ? (span.attributes as Record<string, unknown>)
        : {};
    const rawUrl = attributes["http.url"] ?? attributes["url.full"];
    const url = typeof rawUrl === "string" ? rawUrl : undefined;

    if (url && !provider) {
      provider = inferProviderFromUrl(url);
    }

    const responseBody = getStringField(span, "response_body", "responseBody");

    if (!modelId && responseBody) {
      modelId = extractModelIdFromBody(responseBody);
    }

    const requestBody = getStringField(span, "request_body", "requestBody");

    if (!modelId && requestBody) {
      modelId = extractModelIdFromBody(requestBody);
    }

    if (modelId && provider) {
      break;
    }
  }

  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {})
  };
}

function inferProviderFromUrl(url: string): string | undefined {
  const normalized = url.toLowerCase();

  if (normalized.includes("api.openai.com")) {
    return "openai";
  }

  if (normalized.includes("api.anthropic.com")) {
    return "anthropic";
  }

  if (normalized.includes("generativelanguage.googleapis.com")) {
    return "google";
  }

  return undefined;
}

function normalizeHexId(
  candidate: string | undefined,
  width: number
): string {
  const source = (candidate ?? randomUUID().replaceAll("-", "")).toLowerCase();
  const filtered = source.replace(/[^a-f0-9]/g, "");

  if (filtered.length >= width) {
    return filtered.slice(0, width);
  }

  return filtered.padEnd(width, "0");
}

async function sendAgentFailure(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string,
  error: unknown,
  streamMeta?: AgentStreamMeta,
  agentGoal?: string
): Promise<void> {
  if (options.config.skipWorkflowTypes.has(workflowType)) {
    clearAgentRunState(runId);
    return;
  }
  void streamMeta;

  try {
    await emitAgentOutputSignal(
      options,
      runId,
      workflowId,
      workflowType,
      {
        error: serializeError(error),
        status: "failed"
      },
      agentGoal
    );

    await evaluateAgentEvent(options, {
      error: serializeError(error),
      event_type: WorkflowEventType.WORKFLOW_FAILED,
      ...(agentGoal ? { goal: agentGoal } : {}),
      run_id: runId,
      workflow_id: workflowId,
      workflow_type: workflowType
    });
  } finally {
    clearAgentRunState(runId);
  }
}

async function emitAgentOutputSignal(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string,
  output: unknown,
  goal: string | undefined
): Promise<void> {
  if (options.config.skipSignals.has(AGENT_OUTPUT_SIGNAL_NAME)) {
    return;
  }

  const signalArgs = serializeAgentOutputSignalArgs(output, goal);
  const outputSignalBasePayload = {
    event_type: WorkflowEventType.SIGNAL_RECEIVED,
    ...(goal ? { goal } : {}),
    run_id: runId,
    signal_args: signalArgs,
    signal_name: AGENT_OUTPUT_SIGNAL_NAME,
    task_queue: "mastra",
    workflow_id: workflowId,
    workflow_type: workflowType
  } as const;
  const outputSignalSpans = buildAgentOutputSignalSpans(
    options,
    workflowId,
    runId
  );
  const outputSignalPayload = outputSignalSpans.length > 0
    ? {
        ...outputSignalBasePayload,
        span_count: outputSignalSpans.length,
        spans: outputSignalSpans
      }
    : outputSignalBasePayload;

  await evaluateAgentEvent(
    options,
    outputSignalPayload,
    outputSignalBasePayload
  );
}

async function evaluateAgentEvent(
  options: WrapToolOptions,
  payload: Record<string, unknown> & { event_type: WorkflowEventType },
  fallbackPayload?: Record<string, unknown> & { event_type: WorkflowEventType },
  minimalPayload?: Record<string, unknown> & { event_type: WorkflowEventType }
): Promise<GovernanceVerdictResponse | null> {
  const candidates = buildCandidatePayloads(
    payload,
    fallbackPayload,
    minimalPayload
  ).filter((candidate, index, all) => {
    const isLast = index === all.length - 1;
    return !isPayloadOverBudget(
      candidate.payload,
      options.config.maxEvaluatePayloadBytes,
      isLast
    );
  });
  let resolvedError: unknown = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];

    if (!candidate) {
      continue;
    }

    try {
      const result = await options.client.evaluate({
        source: "workflow-telemetry",
        timestamp: new Date().toISOString(),
        ...candidate.payload
      });

      if (result !== null) {
        return result;
      }

      continue;
    } catch (error) {
      resolvedError = error;
      const hasNext = index < candidates.length - 1;

      if (hasNext && isRecoverableGovernanceError(error)) {
        continue;
      }

      break;
    }
  }

  if (options.config.onApiError === "fail_closed") {
    return {
      action: "stop",
      alignmentScore: undefined,
      approvalId: undefined,
      behavioralViolations: undefined,
      constraints: undefined,
      governanceEventId: undefined,
      guardrailsResult: undefined,
      metadata: undefined,
      policyId: undefined,
      reason: `Governance API error: ${
        resolvedError instanceof Error
          ? resolvedError.message
          : String(resolvedError)
      }`,
      riskScore: 0,
      trustTier: undefined,
      verdict: Verdict.HALT
    } as GovernanceVerdictResponse;
  }

  return null;
}

function isBadRequestSchemaError(error: unknown): boolean {
  return (
    error instanceof GovernanceAPIError &&
    /HTTP 400/i.test(error.message)
  );
}

function isPayloadTooLargeError(error: unknown): boolean {
  return (
    error instanceof GovernanceAPIError &&
    /(blob data size exceeds limit|payload too large|request entity too large|message too large)/i.test(
      error.message
    )
  );
}

function isTransientGovernanceError(error: unknown): boolean {
  if (!(error instanceof GovernanceAPIError)) {
    return false;
  }

  return (
    /HTTP\s(429|5\d\d)\b/i.test(error.message) ||
    /(context deadline exceeded|temporarily unavailable|timeout|timed out|connection reset|econnreset|etimedout|upstream connect error)/i.test(
      error.message
    )
  );
}

function isRecoverableGovernanceError(error: unknown): boolean {
  return (
    isBadRequestSchemaError(error) ||
    isPayloadTooLargeError(error) ||
    isTransientGovernanceError(error)
  );
}

function buildCandidatePayloads(
  payload: Record<string, unknown> & { event_type: WorkflowEventType },
  fallbackPayload?: Record<string, unknown> & { event_type: WorkflowEventType },
  minimalPayload?: Record<string, unknown> & { event_type: WorkflowEventType }
): Array<{
  payload: Record<string, unknown> & { event_type: WorkflowEventType };
}> {
  const candidates = [
    payload,
    fallbackPayload,
    minimalPayload
  ].filter(
    (
      value
    ): value is Record<string, unknown> & { event_type: WorkflowEventType } =>
      value !== undefined
  );
  const deduped: Array<{
    payload: Record<string, unknown> & { event_type: WorkflowEventType };
  }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = safeStringify(candidate);

    if (!seen.has(key)) {
      deduped.push({
        payload: candidate
      });
      seen.add(key);
    }
  }

  return deduped;
}

function isPayloadOverBudget(
  payload: Record<string, unknown>,
  maxBytes: number,
  isLastFallback: boolean
): boolean {
  const serialized = safeStringify(payload);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  if (sizeBytes <= maxBytes || isLastFallback) {
    return false;
  }

  return true;
}

function safeStringify(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "{}";
  }
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

function clearAgentRunState(runId: string): void {
  OPENBOX_AGENT_RUN_GOALS.delete(runId);
  OPENBOX_AGENT_SIGNAL_SPAN_CURSOR.delete(runId);
}

function buildAgentOutputSignalSpans(
  options: WrapToolOptions,
  workflowId: string,
  runId: string
): Array<Record<string, unknown>> {
  const queuedHookSpans = options.spanProcessor.consumeAgentSignalHookSpans(
    workflowId,
    runId
  );

  if (queuedHookSpans.length > 0) {
    return queuedHookSpans
      .slice(-MAX_AGENT_OUTPUT_SIGNAL_SPANS)
      .map(span => compactAgentSignalSpan(span));
  }

  const workflowSpans = normalizeSpansForGovernance(
    options.spanProcessor.getBuffer(workflowId, runId)?.spans ?? []
  );
  const llmSpans = workflowSpans.filter(span => isCompletedLlmAlignmentSpan(span));

  if (llmSpans.length === 0) {
    return [];
  }

  const cursor = OPENBOX_AGENT_SIGNAL_SPAN_CURSOR.get(runId) ?? 0;
  const normalizedCursor =
    cursor >= 0 && cursor <= llmSpans.length ? cursor : 0;
  const unsentSpans = llmSpans.slice(normalizedCursor);

  OPENBOX_AGENT_SIGNAL_SPAN_CURSOR.set(runId, llmSpans.length);

  if (unsentSpans.length === 0) {
    return [];
  }

  const maxSourceSpanCount = Math.max(
    1,
    Math.floor(MAX_AGENT_OUTPUT_SIGNAL_SPANS / 2)
  );

  return unsentSpans
    .slice(-maxSourceSpanCount)
    .flatMap(span => buildAgentOutputSignalSpanPhases(span))
    .map(span => compactAgentSignalSpan(span));
}

function isCompletedLlmAlignmentSpan(span: Record<string, unknown>): boolean {
  const stage = getStringField(span, "stage", "stage");

  if (stage && stage !== "completed") {
    return false;
  }

  const hasCompletedTiming =
    typeof span.end_time === "number" ||
    typeof span.duration_ns === "number";

  if (!stage && !hasCompletedTiming) {
    return false;
  }

  const semanticType = getStringField(span, "semantic_type", "semanticType");

  if (semanticType && semanticType.startsWith("llm_")) {
    return true;
  }

  const attributes =
    span.attributes && typeof span.attributes === "object"
      ? (span.attributes as Record<string, unknown>)
      : {};
  const httpMethod = typeof attributes["http.method"] === "string"
    ? (attributes["http.method"] as string).trim().toUpperCase()
    : undefined;
  const rawUrl = attributes["http.url"] ?? attributes["url.full"];
  const httpUrl = typeof rawUrl === "string" ? rawUrl.toLowerCase() : "";

  if (
    httpMethod === "POST" &&
    (httpUrl.includes("api.openai.com") ||
      httpUrl.includes("api.anthropic.com") ||
      httpUrl.includes("generativelanguage.googleapis.com"))
  ) {
    return true;
  }

  const requestBody = getStringField(span, "request_body", "requestBody");
  const responseBody = getStringField(span, "response_body", "responseBody");

  return (
    httpMethod === "POST" &&
    looksLikeLlmPayload(requestBody, responseBody)
  );
}

function looksLikeLlmPayload(
  requestBody: string | undefined,
  responseBody: string | undefined
): boolean {
  return (
    (typeof requestBody === "string" &&
      extractModelIdFromBody(requestBody) !== undefined) ||
    (typeof responseBody === "string" &&
      (extractModelIdFromBody(responseBody) !== undefined ||
        hasUsageInBody(responseBody)))
  );
}

function compactAgentSignalSpan(
  span: Record<string, unknown>
): Record<string, unknown> {
  const compacted = {
    ...span
  };

  if (typeof compacted.request_body === "string") {
    compacted.request_body = truncateString(
      compacted.request_body,
      MAX_AGENT_SIGNAL_SPAN_BODY_CHARS
    );
  }

  if (typeof compacted.response_body === "string") {
    compacted.response_body = truncateString(
      compacted.response_body,
      MAX_AGENT_SIGNAL_SPAN_BODY_CHARS
    );
  }

  return compacted;
}

function buildAgentOutputSignalSpanPhases(
  span: Record<string, unknown>
): Array<Record<string, unknown>> {
  const completedSpan = normalizeAgentOutputSignalSpan(span, "completed");
  const startedSpan = normalizeAgentOutputSignalSpan(span, "started");

  return [startedSpan, completedSpan];
}

function normalizeAgentOutputSignalSpan(
  span: Record<string, unknown>,
  stage: "completed" | "started"
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...span,
    stage,
    ...(typeof span.semantic_type !== "string" &&
    typeof span.semanticType !== "string"
      ? { semantic_type: "llm_completion" }
      : {})
  };

  if (stage === "started") {
    delete normalized.duration_ns;
    delete normalized.durationNs;
    delete normalized.end_time;
    delete normalized.endTime;
    delete normalized.response_body;
    delete normalized.responseBody;
    delete normalized.response_headers;
    delete normalized.responseHeaders;
    delete normalized.status;
  }

  return normalized;
}

function ensureAgentSpanBuffer(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string
): void {
  const existing = options.spanProcessor.getBuffer(workflowId, runId);

  if (!existing || existing.runId !== runId) {
    options.spanProcessor.registerWorkflow(
      workflowId,
      new WorkflowSpanBuffer({
        runId,
        taskQueue: "mastra",
        workflowId,
        workflowType
      })
    );
  }
}

function getAgentStreamMeta(stream: unknown): AgentStreamMeta | undefined {
  if (!stream || typeof stream !== "object") {
    return undefined;
  }

  return (stream as Record<PropertyKey, unknown>)[
    OPENBOX_AGENT_STREAM_META
  ] as AgentStreamMeta | undefined;
}

function setAgentStreamMeta(
  stream: Record<PropertyKey, unknown>,
  meta: AgentStreamMeta
): void {
  Object.defineProperty(stream, OPENBOX_AGENT_STREAM_META, {
    configurable: true,
    enumerable: false,
    value: meta
  });
}

function attachStreamLifecycleHandlers(
  stream: Record<PropertyKey, unknown>,
  handlers: {
    onFailure: (error: unknown) => Promise<void>;
    onSuccess: (fullOutput: unknown) => Promise<void>;
  }
): void {
  const streamLike = stream as Record<PropertyKey, unknown> & {
    consumeStream?: (...args: unknown[]) => Promise<unknown>;
    fullStream?: unknown;
    getFullOutput?: (...args: unknown[]) => Promise<unknown>;
    _getImmediateFinishReason?: (() => unknown) | undefined;
    _getImmediateText?: (() => unknown) | undefined;
    _getImmediateToolCalls?: (() => unknown) | undefined;
    _getImmediateToolResults?: (() => unknown) | undefined;
    _getImmediateUsage?: (() => unknown) | undefined;
    _getImmediateWarnings?: (() => unknown) | undefined;
    status?: unknown;
  };
  const originalGetFullOutput =
    typeof streamLike.getFullOutput === "function"
      ? streamLike.getFullOutput.bind(streamLike)
      : undefined;
  const originalConsumeStream =
    typeof streamLike.consumeStream === "function"
      ? streamLike.consumeStream.bind(streamLike)
      : undefined;

  if (!originalGetFullOutput && !originalConsumeStream && !isReadableStream(streamLike.fullStream)) {
    return;
  }

  let settled = false;
  let settledPromise: Promise<void> | undefined;

  const settleSuccess = (fullOutput: unknown): Promise<void> => {
    if (settledPromise) {
      return settledPromise;
    }

    settled = true;
    settledPromise = handlers.onSuccess(fullOutput);
    return settledPromise;
  };

  const settleFailure = (error: unknown): Promise<void> => {
    if (settledPromise) {
      return settledPromise;
    }

    settled = true;
    settledPromise = handlers.onFailure(error);
    return settledPromise;
  };

  if (originalGetFullOutput) {
    streamLike.getFullOutput = async (...args: unknown[]) => {
      try {
        const fullOutput = await originalGetFullOutput(...args);
        await settleSuccess(fullOutput);
        return fullOutput;
      } catch (error) {
        await settleFailure(error);
        throw error;
      }
    };
  }

  if (originalConsumeStream) {
    streamLike.consumeStream = async (...args: unknown[]) => {
      try {
        const consumed = await originalConsumeStream(...args);

        if (!settled) {
          const snapshot = buildStreamSnapshot(streamLike);
          await settleSuccess(snapshot).catch(() => {});
        }

        return consumed;
      } catch (error) {
        await settleFailure(error);
        throw error;
      }
    };
  }

  if (isReadableStream(streamLike.fullStream)) {
    const observedStream = streamLike.fullStream.pipeThrough(
      new TransformStream({
        flush() {
          if (settled) {
            return;
          }

          const snapshot = buildStreamSnapshot(streamLike);

          return settleSuccess(snapshot).catch(() => {});
        }
      })
    );

    Object.defineProperty(streamLike, "fullStream", {
      configurable: true,
      enumerable: false,
      value: observedStream,
      writable: true
    });
  }
}

function buildStreamSnapshot(
  stream: {
    _getImmediateFinishReason?: (() => unknown) | undefined;
    _getImmediateText?: (() => unknown) | undefined;
    _getImmediateToolCalls?: (() => unknown) | undefined;
    _getImmediateToolResults?: (() => unknown) | undefined;
    _getImmediateUsage?: (() => unknown) | undefined;
    _getImmediateWarnings?: (() => unknown) | undefined;
    status?: unknown;
  }
): Record<string, unknown> {
  return {
    finishReason: stream._getImmediateFinishReason?.(),
    status: stream.status,
    text: stream._getImmediateText?.(),
    toolCalls: stream._getImmediateToolCalls?.(),
    toolResults: stream._getImmediateToolResults?.(),
    usage: stream._getImmediateUsage?.(),
    warnings: stream._getImmediateWarnings?.()
  };
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipeThrough" in value &&
    typeof (value as { pipeThrough?: unknown }).pipeThrough === "function"
  );
}
