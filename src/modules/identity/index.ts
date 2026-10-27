/** Public API of the identity module. Other modules and the app import only from here. */
export { hasPermission, loadPermissions, requirePermission } from "./authorization";
export { bootstrapOwner, signOut } from "./bootstrap";
export {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_HOUR,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  phoneSchema,
  requestSignInCode,
  SignInError,
  signInWithCode,
  type SignInFailure,
} from "./otp";
export { ConsoleOtpSender, getOtpSender, maskPhone, type OtpSender } from "./otp-provider";
export { hashPin, isOwnerPinSet, PIN_LOCKOUT_SECONDS, PIN_MAX_FAILURES, setOwnerPin, validatePinStrength, verifyOwnerPin } from "./pin";
export { createSession, revokeAllSessionsForUser, SESSION_TTL_SECONDS, validateSessionToken, type SessionContext } from "./sessions";
export { addStaffMember, getStaffMember, listStaff, loadUserNames, revokeStaffAccess, setStaffActive, updateStaffRole, type StaffMember } from "./staff";
export {
  ANY_TARGET,
  APPROVAL_ACTION_LABELS,
  APPROVAL_EXPIRY_MS,
  consumeApproval,
  consumeMatchingApproval,
  countPendingApprovals,
  decideApproval,
  listApprovals,
  REQUESTABLE_ACTIONS,
  requestApproval,
  resolveApprovalStatus,
  type ApprovalAction,
  type ApprovalPayload,
  type ApprovalStatus,
  type RequestableAction,
  type ApprovalView,
} from "./approvals";
export {
  countUnreadNotifications,
  getNotificationPreferences,
  listNotifications,
  markNotificationsRead,
  NOTIFICATION_KIND_LABELS,
  notifyApprovalEvent,
  raiseNotification,
  setNotificationPreference,
  type NewNotification,
  type NotificationResult,
} from "./notifications";
export { NOTIFICATION_KINDS, type NotificationKind } from "./schema";
