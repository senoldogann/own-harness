export class OwnHarnessError extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = "OwnHarnessError"
    this.code = code
  }
}

export class PolicyValidationError extends OwnHarnessError {
  public constructor(message: string) {
    super("POLICY_VALIDATION_ERROR", message)
    this.name = "PolicyValidationError"
  }
}

export class StoreError extends OwnHarnessError {
  public constructor(message: string) {
    super("STORE_ERROR", message)
    this.name = "StoreError"
  }
}

export class ProposalNotFoundError extends OwnHarnessError {
  public constructor(proposalId: string) {
    super("PROPOSAL_NOT_FOUND", `Proposal not found: ${proposalId}`)
    this.name = "ProposalNotFoundError"
  }
}

export class ConfigValidationError extends OwnHarnessError {
  public constructor(message: string) {
    super("CONFIG_VALIDATION_ERROR", message)
    this.name = "ConfigValidationError"
  }
}
