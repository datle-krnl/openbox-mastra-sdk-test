import { AsyncLocalStorage } from "node:async_hooks";

export interface OpenBoxExecutionContext {
  activityId?: string | undefined;
  activityType?: string | undefined;
  agentId?: string | undefined;
  attempt?: number | undefined;
  goal?: string | undefined;
  runId?: string | undefined;
  source?: "agent" | "tool" | "workflow" | undefined;
  taskQueue?: string | undefined;
  workflowId?: string | undefined;
  workflowType?: string | undefined;
}

const executionContextStore = new AsyncLocalStorage<OpenBoxExecutionContext>();

export function getOpenBoxExecutionContext():
  | OpenBoxExecutionContext
  | undefined {
  return executionContextStore.getStore();
}

export async function runWithOpenBoxExecutionContext<T>(
  context: OpenBoxExecutionContext,
  callback: () => Promise<T>
): Promise<T> {
  return executionContextStore.run(context, callback);
}
