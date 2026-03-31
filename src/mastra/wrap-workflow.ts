import type { WorkflowRunOutput } from "@mastra/core/stream";
import type { AnyWorkflow, Step, WorkflowResult } from "@mastra/core/workflows";

import {
  clearPendingApproval,
  getPendingApproval,
  markActivityApproved
} from "../governance/approval-registry.js";
import {
  executeGovernedActivity,
  serializeValue,
  type WorkflowSuspendContext
} from "../governance/activity-runtime.js";
import {
  getOpenBoxExecutionContext,
  runWithOpenBoxExecutionContext
} from "../governance/context.js";
import type { GovernanceVerdictResponse } from "../types/index.js";
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceHaltError,
  Verdict,
  WorkflowEventType
} from "../types/index.js";
import type { WrapToolOptions } from "./wrap-tool.js";

const OPENBOX_WRAPPED_WORKFLOW = Symbol.for("openbox.mastra.wrapWorkflow");
const OPENBOX_WRAPPED_STEP = Symbol.for("openbox.mastra.wrapWorkflow.step");

type WorkflowStep = Step<string, any, any, any, any, any, any, any> & {
  component?: string | undefined;
};

type WorkflowRunLike = Awaited<ReturnType<AnyWorkflow["createRun"]>>;

export function wrapWorkflow<TWorkflow>(workflow: TWorkflow, options: WrapToolOptions): TWorkflow {
  const baseWorkflow = workflow as AnyWorkflow & Record<PropertyKey, unknown> & {
    createRun: AnyWorkflow["createRun"];
    id: string;
    steps: Record<string, WorkflowStep>;
  };

  if (baseWorkflow[OPENBOX_WRAPPED_WORKFLOW]) {
    return workflow;
  }

  for (const step of Object.values(baseWorkflow.steps ?? {})) {
    if (
      step.component === "TOOL" ||
      ((step as unknown as Record<PropertyKey, unknown>)[OPENBOX_WRAPPED_STEP] ??
        false)
    ) {
      continue;
    }

    wrapStep(step, options);
  }

  const originalCreateRun = baseWorkflow.createRun.bind(baseWorkflow);

  baseWorkflow.createRun = (async (...args: Parameters<AnyWorkflow["createRun"]>) => {
    const run = (await originalCreateRun(...args)) as WorkflowRunLike;

    return wrapRun(run, baseWorkflow, options);
  }) as AnyWorkflow["createRun"];

  Object.defineProperty(baseWorkflow, OPENBOX_WRAPPED_WORKFLOW, {
    enumerable: false,
    value: true
  });

  return workflow;
}

function wrapStep(step: WorkflowStep, options: WrapToolOptions): void {
  const originalExecute = step.execute.bind(step);

  step.execute = (async params => {
    const executionContext = getOpenBoxExecutionContext();
    const workflowType = executionContext?.workflowType ?? params.workflowId;

    if (
      options.config.skipWorkflowTypes.has(workflowType) ||
      options.config.skipActivityTypes.has(step.id)
    ) {
      return originalExecute(params);
    }

    return executeGovernedActivity({
      dependencies: {
        client: options.client,
        config: options.config,
        spanProcessor: options.spanProcessor
      },
      execute: async governedInput => {
        return originalExecute({
          ...params,
          inputData: governedInput
        });
      },
      input: params.inputData,
      runtimeContext: {
        workflow: {
          runId: params.runId,
          setState: params.setState,
          state: params.state,
          suspend: params.suspend,
          workflowId: params.workflowId
        } satisfies WorkflowSuspendContext
      },
      type: step.id
    });
  }) as WorkflowStep["execute"];

  Object.defineProperty(step, OPENBOX_WRAPPED_STEP, {
    enumerable: false,
    value: true
  });
}

function wrapRun(
  run: WorkflowRunLike,
  workflow: AnyWorkflow & { id: string },
  options: WrapToolOptions
): WorkflowRunLike {
  const baseRun = run as WorkflowRunLike & Record<string, unknown>;
  const originalStart = run.start.bind(run);
  const originalResume = run.resume.bind(run);
  const originalStream = run.stream.bind(run);
  const originalResumeStream = run.resumeStream.bind(run);

  baseRun.start = (async (...args: Parameters<typeof run.start>) => {
    const [startArgs] = args;

    return executeWorkflowRun(
      {
        run,
        workflow,
        options
      },
      "start",
      async () => originalStart(...args),
      startArgs?.inputData
    );
  }) as typeof run.start;

  baseRun.resume = (async (...args: Parameters<typeof run.resume>) => {
    const [resumeArgs] = args;

    await handleResumeSignal(run, workflow, options, resumeArgs);
    await pollPendingApproval(run, options);

    return executeWorkflowRun(
      {
        run,
        workflow,
        options
      },
      "resume",
      async () => originalResume(...args)
    );
  }) as typeof run.resume;

  baseRun.stream = ((...args: Parameters<typeof run.stream>) => {
    const [streamArgs] = args;

    return executeWorkflowStream(
      {
        run,
        workflow,
        options
      },
      async () => originalStream(...args),
      streamArgs?.inputData
    );
  }) as typeof run.stream;

  baseRun.resumeStream = ((...args: Parameters<typeof run.resumeStream>) => {
    const [resumeArgs] = args;

    const streamFactory = async () => {
      await handleResumeSignal(run, workflow, options, resumeArgs);
      await pollPendingApproval(run, options);

      return originalResumeStream(...args);
    };

    return executeWorkflowStream(
      {
        run,
        workflow,
        options
      },
      streamFactory
    );
  }) as typeof run.resumeStream;

  return run;
}

async function executeWorkflowRun(
  context: {
    options: WrapToolOptions;
    run: WorkflowRunLike;
    workflow: AnyWorkflow & { id: string };
  },
  phase: "resume" | "start",
  operation: () => Promise<WorkflowResult<any, any, any, any>>,
  inputData?: unknown
): Promise<WorkflowResult<any, any, any, any>> {
  const { options, run, workflow } = context;

  if (
    phase === "start" &&
    !options.config.skipWorkflowTypes.has(workflow.id) &&
    options.config.sendStartEvent
  ) {
    const startVerdict = await evaluateWorkflowEvent(context, {
      event_type: WorkflowEventType.WORKFLOW_STARTED,
      run_id: run.runId,
      task_queue: "mastra",
      workflow_id: workflow.id,
      workflow_type: workflow.id
    });

    if (startVerdict && Verdict.shouldStop(startVerdict.verdict)) {
      throw new GovernanceHaltError(
        startVerdict.reason ?? "Workflow blocked by governance"
      );
    }
  }

  return runWithOpenBoxExecutionContext(
    {
      runId: run.runId,
      source: "workflow",
      taskQueue: "mastra",
      workflowId: workflow.id,
      workflowType: workflow.id
    },
    async () => {
      try {
        const result = await operation();

        await finalizeWorkflowResult(context, result, inputData);
        return result;
      } catch (error) {
        await sendWorkflowFailure(context, error);
        throw error;
      }
    }
  );
}

function executeWorkflowStream(
  context: {
    options: WrapToolOptions;
    run: WorkflowRunLike;
    workflow: AnyWorkflow & { id: string };
  },
  operation: () => Promise<WorkflowRunOutput<WorkflowResult<any, any, any, any>>>,
  inputData?: unknown
): WorkflowRunOutput<WorkflowResult<any, any, any, any>> {
  const { options, run, workflow } = context;
  const streamPromise = runWithOpenBoxExecutionContext(
    {
      runId: run.runId,
      source: "workflow",
      taskQueue: "mastra",
      workflowId: workflow.id,
      workflowType: workflow.id
    },
    async () => {
      if (
        !options.config.skipWorkflowTypes.has(workflow.id) &&
        options.config.sendStartEvent
      ) {
        const startVerdict = await evaluateWorkflowEvent(context, {
          event_type: WorkflowEventType.WORKFLOW_STARTED,
          run_id: run.runId,
          task_queue: "mastra",
          workflow_id: workflow.id,
          workflow_type: workflow.id
        });

        if (startVerdict && Verdict.shouldStop(startVerdict.verdict)) {
          throw new GovernanceHaltError(
            startVerdict.reason ?? "Workflow blocked by governance"
          );
        }
      }

      return operation();
    }
  );
  const placeholder = Object.create(null) as WorkflowRunOutput<
    WorkflowResult<any, any, any, any>
  >;

  void streamPromise.then(output => {
    Object.assign(placeholder, output);

    void output.result
      .then(result => finalizeWorkflowResult(context, result, inputData))
      .catch(error => sendWorkflowFailure(context, error));
  });

  return new Proxy(placeholder, {
    get(_target, property, receiver) {
      if (property in placeholder) {
        return Reflect.get(placeholder, property, receiver);
      }

      return async (...args: unknown[]) => {
        const output = await streamPromise;
        const value = Reflect.get(output, property, receiver);

        if (typeof value === "function") {
          return Reflect.apply(value, output, args);
        }

        return value;
      };
    }
  });
}

async function finalizeWorkflowResult(
  context: {
    options: WrapToolOptions;
    run: WorkflowRunLike;
    workflow: AnyWorkflow & { id: string };
  },
  result: WorkflowResult<any, any, any, any>,
  inputData?: unknown
): Promise<void> {
  if (result.status === "success") {
    const completedVerdict = await evaluateWorkflowEvent(context, {
      event_type: WorkflowEventType.WORKFLOW_COMPLETED,
      run_id: context.run.runId,
      workflow_id: context.workflow.id,
      workflow_output: serializeValue(result.result),
      workflow_type: context.workflow.id
    });

    if (completedVerdict && Verdict.shouldStop(completedVerdict.verdict)) {
      throw new GovernanceHaltError(
        completedVerdict.reason ?? "Workflow blocked by governance"
      );
    }
    return;
  }

  if (result.status === "failed" || result.status === "tripwire") {
    await sendWorkflowFailure(
      context,
      result.status === "failed"
        ? result.error
        : new Error("Workflow failed due to tripwire")
    );
    return;
  }

  void inputData;
}

async function sendWorkflowFailure(
  context: {
    options: WrapToolOptions;
    run: WorkflowRunLike;
    workflow: AnyWorkflow & { id: string };
  },
  error: unknown
): Promise<void> {
  await evaluateWorkflowEvent(context, {
    error: serializeError(error),
    event_type: WorkflowEventType.WORKFLOW_FAILED,
    run_id: context.run.runId,
    workflow_id: context.workflow.id,
    workflow_type: context.workflow.id
  });
}

async function handleResumeSignal(
  run: WorkflowRunLike,
  workflow: AnyWorkflow & { id: string },
  options: WrapToolOptions,
  resumeArgs: {
    forEachIndex?: number | undefined;
    label?: string | undefined;
    resumeData?: unknown;
    step?: string | string[] | unknown;
  } | undefined
): Promise<void> {
  const signalName = resumeArgs?.label ?? "resume";

  if (
    options.config.skipWorkflowTypes.has(workflow.id) ||
    options.config.skipSignals.has(signalName)
  ) {
    return;
  }

  const verdict = await evaluateWorkflowEvent(
    {
      options,
      run,
      workflow
    },
    {
      event_type: WorkflowEventType.SIGNAL_RECEIVED,
      run_id: run.runId,
      signal_args: serializeValue({
        forEachIndex: resumeArgs?.forEachIndex,
        resumeData: resumeArgs?.resumeData,
        step: resumeArgs?.step
      }),
      signal_name: signalName,
      task_queue: "mastra",
      workflow_id: workflow.id,
      workflow_type: workflow.id
    }
  );

  if (verdict && Verdict.shouldStop(verdict.verdict)) {
    options.spanProcessor.setVerdict(
      workflow.id,
      verdict.verdict,
      verdict.reason,
      run.runId
    );
    throw new GovernanceHaltError(
      verdict.reason ?? "Workflow blocked by governance"
    );
  }
}

async function pollPendingApproval(
  run: WorkflowRunLike,
  options: WrapToolOptions
): Promise<void> {
  const pending = getPendingApproval(run.runId);

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
    clearPendingApproval(run.runId);
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
    clearPendingApproval(run.runId);
    return;
  }

  if (Verdict.shouldStop(verdict)) {
    clearPendingApproval(run.runId);
    throw new ApprovalRejectedError(
      `Activity rejected: ${String(approval.reason ?? "Activity rejected")}`
    );
  }

  throw new ApprovalPendingError(
    `Awaiting approval for activity ${pending.activityType}`
  );
}

async function evaluateWorkflowEvent(
  context: {
    options: WrapToolOptions;
    run: WorkflowRunLike;
    workflow: AnyWorkflow & { id: string };
  },
  payload: Record<string, unknown> & { event_type: WorkflowEventType }
): Promise<GovernanceVerdictResponse | null> {
  if (context.options.config.skipWorkflowTypes.has(context.workflow.id)) {
    return null;
  }

  try {
    return await context.options.client.evaluate({
      source: "workflow-telemetry",
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (error) {
    if (context.options.config.onApiError === "fail_closed") {
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
          error instanceof Error ? error.message : String(error)
        }`,
        riskScore: 0,
        trustTier: undefined,
        verdict: Verdict.HALT
      } as GovernanceVerdictResponse;
    }

    return null;
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
