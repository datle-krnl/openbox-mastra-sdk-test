export interface PendingApprovalEntry {
  activityId: string;
  activityType: string;
  approvalId?: string | undefined;
  requestedAt: string;
  runId: string;
  workflowId: string;
  workflowType: string;
}

const pendingApprovals = new Map<string, PendingApprovalEntry>();
const approvedActivities = new Set<string>();

function toApprovedActivityKey(runId: string, activityId: string): string {
  return `${runId}::${activityId}`;
}

export function getPendingApproval(runId: string): PendingApprovalEntry | undefined {
  return pendingApprovals.get(runId);
}

export function setPendingApproval(entry: PendingApprovalEntry): void {
  pendingApprovals.set(entry.runId, entry);
}

export function clearPendingApproval(runId: string): void {
  pendingApprovals.delete(runId);
}

export function markActivityApproved(runId: string, activityId: string): void {
  approvedActivities.add(toApprovedActivityKey(runId, activityId));
}

export function isActivityApproved(runId: string, activityId: string): boolean {
  return approvedActivities.has(toApprovedActivityKey(runId, activityId));
}

export function clearActivityApproval(runId: string, activityId: string): void {
  approvedActivities.delete(toApprovedActivityKey(runId, activityId));
}
