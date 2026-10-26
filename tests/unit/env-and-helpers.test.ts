import { describe, expect, it } from "vitest";
import { maskPhone, validatePinStrength } from "@/modules/identity";
import { getAuthEnv, getDbEnv } from "@/server/env";
import { financialYearLabel } from "@/shared/financial-year";
import { defaultPermissionRows, PERMISSIONS, ROLE_NAMES } from "@/shared/permissions";

const pepper = "p".repeat(40);

describe("environment validation", () => {
  it("requires a long OTP pepper", () => {
    expect(() => getAuthEnv({ NODE_ENV: "development" })).toThrow(/OTP_PEPPER/);
    expect(() => getAuthEnv({ NODE_ENV: "development", OTP_PEPPER: "short" })).toThrow(/at least 32/);
  });

  it("treats an empty setup token as disabled and refuses weak ones", () => {
    expect(getAuthEnv({ NODE_ENV: "development", OTP_PEPPER: pepper, SETUP_TOKEN: "" }).SETUP_TOKEN).toBeUndefined();
    expect(() => getAuthEnv({ NODE_ENV: "development", OTP_PEPPER: pepper, SETUP_TOKEN: "abc" })).toThrow(/SETUP_TOKEN/);
  });

  it("forbids the console OTP provider in production", () => {
    expect(() => getAuthEnv({ NODE_ENV: "production", OTP_PEPPER: pepper, SMS_PROVIDER: "console" })).toThrow(/not allowed in production/);
    expect(getAuthEnv({ NODE_ENV: "production", OTP_PEPPER: pepper, SMS_PROVIDER: "msg91" }).SMS_PROVIDER).toBe("msg91");
  });

  it("validates the database URL", () => {
    expect(() => getDbEnv({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
    expect(() => getDbEnv({ NODE_ENV: "test", DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
  });
});

describe("helpers", () => {
  it("masks phone numbers for logs", () => {
    expect(maskPhone("9876543210")).toBe("••••••3210");
  });

  it("labels the Indian financial year in Asia/Kolkata", () => {
    expect(financialYearLabel(new Date("2026-10-25T10:00:00Z"))).toBe("26-27");
    expect(financialYearLabel(new Date("2027-03-31T17:00:00Z"))).toBe("26-27"); // 31 Mar, 10:30 PM IST
    expect(financialYearLabel(new Date("2027-03-31T19:00:00Z"))).toBe("27-28"); // 1 Apr, 12:30 AM IST
  });

  it("builds one default permission row per role and permission", () => {
    expect(defaultPermissionRows()).toHaveLength(PERMISSIONS.length * ROLE_NAMES.length);
  });

  it("accepts reasonable PINs only", () => {
    expect(() => validatePinStrength("2580")).not.toThrow();
    expect(() => validatePinStrength("4721")).not.toThrow();
    expect(() => validatePinStrength("0123")).toThrow();
    expect(() => validatePinStrength("3210")).toThrow();
  });
});
