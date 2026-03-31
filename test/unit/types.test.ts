import {
  GovernanceVerdictResponse,
  GuardrailsCheckResult,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "../../src/index.js";

describe("WorkflowEventType", () => {
  it("matches the canonical event names", () => {
    expect(WorkflowEventType.WORKFLOW_STARTED).toBe("WorkflowStarted");
    expect(WorkflowEventType.WORKFLOW_COMPLETED).toBe("WorkflowCompleted");
    expect(WorkflowEventType.WORKFLOW_FAILED).toBe("WorkflowFailed");
    expect(WorkflowEventType.SIGNAL_RECEIVED).toBe("SignalReceived");
    expect(WorkflowEventType.ACTIVITY_STARTED).toBe("ActivityStarted");
    expect(WorkflowEventType.ACTIVITY_COMPLETED).toBe("ActivityCompleted");
  });
});

describe("Verdict", () => {
  it("matches canonical verdict values", () => {
    expect(Verdict.ALLOW).toBe("allow");
    expect(Verdict.CONSTRAIN).toBe("constrain");
    expect(Verdict.REQUIRE_APPROVAL).toBe("require_approval");
    expect(Verdict.BLOCK).toBe("block");
    expect(Verdict.HALT).toBe("halt");
  });

  it("parses legacy strings with compatibility mappings", () => {
    expect(Verdict.fromString("continue")).toBe(Verdict.ALLOW);
    expect(Verdict.fromString("STOP")).toBe(Verdict.HALT);
    expect(Verdict.fromString("require-approval")).toBe(
      Verdict.REQUIRE_APPROVAL
    );
    expect(Verdict.fromString("request_approval")).toBe(
      Verdict.REQUIRE_APPROVAL
    );
  });

  it("parses canonical verdict strings case-insensitively", () => {
    expect(Verdict.fromString("ALLOW")).toBe(Verdict.ALLOW);
    expect(Verdict.fromString("constrain")).toBe(Verdict.CONSTRAIN);
    expect(Verdict.fromString("REQUIRE_APPROVAL")).toBe(
      Verdict.REQUIRE_APPROVAL
    );
    expect(Verdict.fromString("block")).toBe(Verdict.BLOCK);
    expect(Verdict.fromString("HALT")).toBe(Verdict.HALT);
  });

  it("defaults invalid and missing values to allow", () => {
    expect(Verdict.fromString()).toBe(Verdict.ALLOW);
    expect(Verdict.fromString(null)).toBe(Verdict.ALLOW);
    expect(Verdict.fromString("random_string")).toBe(Verdict.ALLOW);
  });

  it("keeps verdict priority ordering", () => {
    expect(Verdict.priorityOf(Verdict.ALLOW)).toBe(1);
    expect(Verdict.priorityOf(Verdict.CONSTRAIN)).toBe(2);
    expect(Verdict.priorityOf(Verdict.REQUIRE_APPROVAL)).toBe(3);
    expect(Verdict.priorityOf(Verdict.BLOCK)).toBe(4);
    expect(Verdict.priorityOf(Verdict.HALT)).toBe(5);
  });

  it("returns the highest-priority verdict", () => {
    expect(
      Verdict.highestPriority([
        Verdict.ALLOW,
        Verdict.CONSTRAIN,
        Verdict.REQUIRE_APPROVAL
      ])
    ).toBe(Verdict.REQUIRE_APPROVAL);
    expect(Verdict.highestPriority([])).toBe(Verdict.ALLOW);
  });

  it("matches stop and approval helper behavior", () => {
    expect(Verdict.shouldStop(Verdict.BLOCK)).toBe(true);
    expect(Verdict.shouldStop(Verdict.HALT)).toBe(true);
    expect(Verdict.shouldStop(Verdict.CONSTRAIN)).toBe(false);
    expect(Verdict.requiresApproval(Verdict.REQUIRE_APPROVAL)).toBe(true);
    expect(Verdict.requiresApproval(Verdict.ALLOW)).toBe(false);
  });
});

describe("WorkflowSpanBuffer", () => {
  it("uses SDK defaults", () => {
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    expect(buffer.parentWorkflowId).toBeUndefined();
    expect(buffer.spans).toEqual([]);
    expect(buffer.status).toBeUndefined();
    expect(buffer.error).toBeUndefined();
    expect(buffer.verdict).toBeUndefined();
    expect(buffer.verdictReason).toBeUndefined();
    expect(buffer.pendingApproval).toBe(false);
  });

  it("does not share span arrays across instances", () => {
    const first = new WorkflowSpanBuffer({
      runId: "run-1",
      taskQueue: "test-queue",
      workflowId: "wf-1",
      workflowType: "TestWorkflow"
    });
    const second = new WorkflowSpanBuffer({
      runId: "run-2",
      taskQueue: "test-queue",
      workflowId: "wf-2",
      workflowType: "TestWorkflow"
    });

    first.spans.push({ name: "span-1" });

    expect(first.spans).toHaveLength(1);
    expect(second.spans).toHaveLength(0);
  });
});

describe("GuardrailsCheckResult", () => {
  it("extracts reason strings from guardrail reasons", () => {
    const result = new GuardrailsCheckResult({
      inputType: "activity_input",
      reasons: [
        { field: "email", reason: "Contains PII", type: "pii" },
        { field: "amount", reason: "Exceeds limit", type: "validation" },
        { field: "empty", reason: "", type: "validation" },
        { field: "ignored", type: "validation" }
      ],
      redactedInput: {}
    });

    expect(result.getReasonStrings()).toEqual([
      "Contains PII",
      "Exceeds limit"
    ]);
  });

  it("defaults optional fields", () => {
    const result = new GuardrailsCheckResult({
      inputType: "activity_output",
      redactedInput: { email: "[REDACTED]" }
    });

    expect(result.rawLogs).toBeUndefined();
    expect(result.validationPassed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("GovernanceVerdictResponse", () => {
  it("maps action for backward compatibility", () => {
    expect(
      new GovernanceVerdictResponse({ verdict: Verdict.ALLOW }).action
    ).toBe("continue");
    expect(
      new GovernanceVerdictResponse({ verdict: Verdict.HALT }).action
    ).toBe("stop");
    expect(
      new GovernanceVerdictResponse({ verdict: Verdict.REQUIRE_APPROVAL }).action
    ).toBe("require-approval");
    expect(
      new GovernanceVerdictResponse({ verdict: Verdict.CONSTRAIN }).action
    ).toBe("constrain");
  });

  it("parses legacy action responses", () => {
    const response = GovernanceVerdictResponse.fromObject({
      action: "require-approval",
      reason: "Needs review"
    });

    expect(response.verdict).toBe(Verdict.REQUIRE_APPROVAL);
    expect(response.reason).toBe("Needs review");
    expect(response.riskScore).toBe(0);
  });

  it("parses canonical verdict responses and prefers verdict over action", () => {
    const response = GovernanceVerdictResponse.fromObject({
      action: "continue",
      approval_id: "approval-123",
      behavioral_violations: ["violation-1"],
      constraints: [{ type: "rate_limit", value: 50 }],
      trust_tier: "elevated",
      verdict: "block"
    });

    expect(response.verdict).toBe(Verdict.BLOCK);
    expect(response.approvalId).toBe("approval-123");
    expect(response.behavioralViolations).toEqual(["violation-1"]);
    expect(response.constraints).toEqual([{ type: "rate_limit", value: 50 }]);
    expect(response.trustTier).toBe("elevated");
  });

  it("parses guardrails payloads with defaults", () => {
    const response = GovernanceVerdictResponse.fromObject({
      guardrails_result: {
        input_type: "activity_input",
        raw_logs: { log_id: "123" },
        reasons: null,
        redacted_input: { email: "[REDACTED]" },
        validation_passed: false
      },
      verdict: "allow"
    });

    expect(response.guardrailsResult).toBeInstanceOf(GuardrailsCheckResult);
    expect(response.guardrailsResult?.redactedInput).toEqual({
      email: "[REDACTED]"
    });
    expect(response.guardrailsResult?.inputType).toBe("activity_input");
    expect(response.guardrailsResult?.rawLogs).toEqual({ log_id: "123" });
    expect(response.guardrailsResult?.validationPassed).toBe(false);
    expect(response.guardrailsResult?.reasons).toEqual([]);
  });

  it("defaults empty payloads to an allow verdict", () => {
    const response = GovernanceVerdictResponse.fromObject({});

    expect(response.verdict).toBe(Verdict.ALLOW);
    expect(response.riskScore).toBe(0);
    expect(response.guardrailsResult).toBeUndefined();
  });
});
