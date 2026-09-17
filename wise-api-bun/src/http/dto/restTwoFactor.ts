/**
 * DTO returned by GET /api/restful/account/twoFactor.
 * Represents the current two-step verification status of the authenticated account.
 */
export interface RestTwoFactorStatus {
  enabled: boolean;
  pendingEnrollment: boolean;
  recoveryCodesRemaining: number;
  reenrollRequired: boolean;
  activatedAt: number | null;
}

/**
 * DTO returned by POST /api/restful/account/twoFactor/enrollment.
 * The setup key is returned separately from the URI so the QR path and the
 * manual-entry path can never disagree (D16, UX-DR11).
 */
export interface RestEnrollment {
  otpauthUri: string;
  setupKey: string;
}

/**
 * DTO returned by PUT /api/restful/account/twoFactor/enrollment (FR5, FR7).
 * Plaintext recovery codes are returned ONLY by the activation response (D16).
 */
export interface RestRecoveryCodes {
  recoveryCodes: string[];
}

/**
 * DTO representing an active trusted device (FR18).
 */
export interface RestTrustedDevice {
  id: number;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

/**
 * DTO returned by GET /api/restful/account/twoFactor/devices (FR18).
 */
export interface RestTrustedDeviceList {
  devices: RestTrustedDevice[];
}

/**
 * DTO for a single security audit event (FR34, FR37).
 */
export interface RestSecurityEvent {
  id: number;
  actorEmail: string;
  action: string;
  outcome: string;
  reason: string | null;
  detail: string | null;
  createdAt: number;
  affectedAccountId?: number;
  affectedAccountEmail?: string | null;
}

/**
 * DTO returned by GET /api/restful/account/securityEvents.
 */
export interface RestSecurityEventList {
  events: RestSecurityEvent[];
}
