/** Public API of the identity module. Other modules and the app import only from here. */
export { hasPermission, requirePermission } from "./authorization";
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
export { addStaffMember, getStaffMember, listStaff, setStaffActive, type StaffMember } from "./staff";
