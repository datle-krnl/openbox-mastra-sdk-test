export class OpenBoxError extends Error {
  public constructor(message = "") {
    super(message);
    this.name = new.target.name;
  }
}

export class OpenBoxConfigError extends OpenBoxError {}

export class OpenBoxAuthError extends OpenBoxConfigError {}

export class OpenBoxNetworkError extends OpenBoxConfigError {}

export class OpenBoxInsecureURLError extends OpenBoxConfigError {}

export class GovernanceAPIError extends OpenBoxError {}

export class GovernanceHaltError extends OpenBoxError {}

export class GuardrailsValidationError extends OpenBoxError {}

export class ApprovalPendingError extends OpenBoxError {}

export class ApprovalRejectedError extends OpenBoxError {}

export class ApprovalExpiredError extends OpenBoxError {}
