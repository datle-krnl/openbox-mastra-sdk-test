import type { Verdict } from "./verdict.js";

export interface WorkflowSpanBufferInit {
  error?: Record<string, unknown> | undefined;
  parentWorkflowId?: string | undefined;
  pendingApproval?: boolean | undefined;
  runId: string;
  spans?: Record<string, unknown>[] | undefined;
  status?: string | undefined;
  taskQueue: string;
  verdict?: Verdict | undefined;
  verdictReason?: string | undefined;
  workflowId: string;
  workflowType: string;
}

export class WorkflowSpanBuffer {
  public error: Record<string, unknown> | undefined;
  public parentWorkflowId: string | undefined;
  public pendingApproval: boolean;
  public readonly runId: string;
  public spans: Record<string, unknown>[];
  public status: string | undefined;
  public readonly taskQueue: string;
  public verdict: Verdict | undefined;
  public verdictReason: string | undefined;
  public readonly workflowId: string;
  public readonly workflowType: string;

  public constructor({
    error,
    parentWorkflowId,
    pendingApproval = false,
    runId,
    spans = [],
    status,
    taskQueue,
    verdict,
    verdictReason,
    workflowId,
    workflowType
  }: WorkflowSpanBufferInit) {
    this.error = error;
    this.parentWorkflowId = parentWorkflowId;
    this.pendingApproval = pendingApproval;
    this.runId = runId;
    this.spans = [...spans];
    this.status = status;
    this.taskQueue = taskQueue;
    this.verdict = verdict;
    this.verdictReason = verdictReason;
    this.workflowId = workflowId;
    this.workflowType = workflowType;
  }
}
