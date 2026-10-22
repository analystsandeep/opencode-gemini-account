/** Base error for all connector failures. `code` is stable and machine-readable. */
export class ConnectorError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.hint = options?.hint;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** Message safe to show to an end user (never contains tokens). */
  toUserMessage(): string {
    return this.hint ? `${this.message}\n${this.hint}` : this.message;
  }
}

/** OAuth protocol failure (authorize / token / refresh / revoke). */
export class OAuthError extends ConnectorError {
  readonly oauthError?: string;
  readonly status?: number;

  constructor(
    message: string,
    options?: { oauthError?: string; status?: number; hint?: string; cause?: unknown },
  ) {
    super("oauth_error", message, options);
    this.name = "OAuthError";
    this.oauthError = options?.oauthError;
    this.status = options?.status;
  }

  get requiresRelogin(): boolean {
    return this.oauthError === "invalid_grant" || this.oauthError === "invalid_client";
  }
}

/** Non-2xx response from the Cloud Code Assist (v1internal) API. */
export class CodeAssistError extends ConnectorError {
  readonly status: number;
  readonly googleStatus?: string;
  readonly bodySnippet?: string;

  constructor(
    status: number,
    message: string,
    options?: { googleStatus?: string; bodySnippet?: string; hint?: string },
  ) {
    super("code_assist_error", message, options);
    this.name = "CodeAssistError";
    this.status = status;
    this.googleStatus = options?.googleStatus;
    this.bodySnippet = options?.bodySnippet;
  }
}

export interface EligibilityFailureShape {
  status: string;
  planLabel: string;
  reasons: string[];
  validationUrl?: string;
}

/** The Google account signed in fine, but is not entitled to a usable tier. */
export class EligibilityError extends ConnectorError {
  readonly result: EligibilityFailureShape;

  constructor(result: EligibilityFailureShape) {
    const reasons = result.reasons.length > 0 ? result.reasons.join(", ") : "No eligible Gemini tier was returned for this account.";
    super("account_ineligible", `Google account is not eligible for Gemini model access (${result.status}): ${reasons}`, {
      hint: result.validationUrl
        ? `Complete Google account validation first: ${result.validationUrl}`
        : "Run `npx opencode-gemini-account doctor` for a full eligibility report, or see the Eligibility section of the README.",
    });
    this.name = "EligibilityError";
    this.result = result;
  }
}
