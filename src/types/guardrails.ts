export interface GuardrailReason {
  field?: string;
  reason?: string;
  type?: string;
}

export interface GuardrailsCheckResultInit {
  inputType: string;
  rawLogs?: Record<string, unknown> | undefined;
  reasons?: GuardrailReason[] | undefined;
  redactedInput: unknown;
  validationPassed?: boolean | undefined;
}

export class GuardrailsCheckResult {
  public readonly inputType: string;
  public readonly rawLogs: Record<string, unknown> | undefined;
  public readonly reasons: GuardrailReason[];
  public readonly redactedInput: unknown;
  public readonly validationPassed: boolean;

  public constructor({
    inputType,
    rawLogs,
    reasons = [],
    redactedInput,
    validationPassed = true
  }: GuardrailsCheckResultInit) {
    this.inputType = inputType;
    this.rawLogs = rawLogs;
    this.reasons = reasons;
    this.redactedInput = redactedInput;
    this.validationPassed = validationPassed;
  }

  public getReasonStrings(): string[] {
    return this.reasons
      .map(reason => reason.reason)
      .filter((reason): reason is string => Boolean(reason));
  }
}
