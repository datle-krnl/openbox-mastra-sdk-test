import {
  GuardrailsCheckResult,
  type GuardrailReason
} from "./guardrails.js";
import { Verdict } from "./verdict.js";

export interface GovernanceVerdictResponseInit {
  alignmentScore?: number | undefined;
  approvalId?: string | undefined;
  behavioralViolations?: string[] | undefined;
  constraints?: Record<string, unknown>[] | undefined;
  governanceEventId?: string | undefined;
  guardrailsResult?: GuardrailsCheckResult | undefined;
  metadata?: Record<string, unknown> | undefined;
  policyId?: string | undefined;
  reason?: string | undefined;
  riskScore?: number | undefined;
  trustTier?: string | undefined;
  verdict: Verdict;
}

type GovernanceVerdictResponseWire = {
  action?: string;
  alignment_score?: number;
  approval_id?: string;
  behavioral_violations?: string[];
  constraints?: Record<string, unknown>[];
  governance_event_id?: string;
  guardrails_result?: {
    input_type?: string;
    raw_logs?: Record<string, unknown>;
    reasons?: GuardrailReason[] | null;
    redacted_input: unknown;
    validation_passed?: boolean;
  } | null;
  metadata?: Record<string, unknown>;
  policy_id?: string;
  reason?: string;
  risk_score?: number;
  trust_tier?: string;
  verdict?: string;
};

export class GovernanceVerdictResponse {
  public readonly alignmentScore: number | undefined;
  public readonly approvalId: string | undefined;
  public readonly behavioralViolations: string[] | undefined;
  public readonly constraints: Record<string, unknown>[] | undefined;
  public readonly governanceEventId: string | undefined;
  public readonly guardrailsResult: GuardrailsCheckResult | undefined;
  public readonly metadata: Record<string, unknown> | undefined;
  public readonly policyId: string | undefined;
  public readonly reason: string | undefined;
  public readonly riskScore: number;
  public readonly trustTier: string | undefined;
  public readonly verdict: Verdict;

  public constructor({
    alignmentScore,
    approvalId,
    behavioralViolations,
    constraints,
    governanceEventId,
    guardrailsResult,
    metadata,
    policyId,
    reason,
    riskScore = 0,
    trustTier,
    verdict
  }: GovernanceVerdictResponseInit) {
    this.alignmentScore = alignmentScore;
    this.approvalId = approvalId;
    this.behavioralViolations = behavioralViolations;
    this.constraints = constraints;
    this.governanceEventId = governanceEventId;
    this.guardrailsResult = guardrailsResult;
    this.metadata = metadata;
    this.policyId = policyId;
    this.reason = reason;
    this.riskScore = riskScore;
    this.trustTier = trustTier;
    this.verdict = verdict;
  }

  public get action(): string {
    if (this.verdict === Verdict.ALLOW) {
      return "continue";
    }

    if (this.verdict === Verdict.HALT) {
      return "stop";
    }

    if (this.verdict === Verdict.REQUIRE_APPROVAL) {
      return "require-approval";
    }

    return this.verdict;
  }

  public static fromObject(
    data: GovernanceVerdictResponseWire
  ): GovernanceVerdictResponse {
    const guardrailsResult =
      data.guardrails_result && Object.keys(data.guardrails_result).length > 0
        ? new GuardrailsCheckResult({
            inputType: data.guardrails_result.input_type ?? "",
            rawLogs: data.guardrails_result.raw_logs,
            reasons: data.guardrails_result.reasons ?? [],
            redactedInput: data.guardrails_result.redacted_input,
            validationPassed:
              data.guardrails_result.validation_passed ?? true
          })
        : undefined;

    return new GovernanceVerdictResponse({
      alignmentScore: data.alignment_score,
      approvalId: data.approval_id,
      behavioralViolations: data.behavioral_violations,
      constraints: data.constraints,
      governanceEventId: data.governance_event_id,
      guardrailsResult,
      metadata: data.metadata,
      policyId: data.policy_id,
      reason: data.reason,
      riskScore: data.risk_score ?? 0,
      trustTier: data.trust_tier,
      verdict: Verdict.fromString(data.verdict ?? data.action ?? "continue")
    });
  }
}
