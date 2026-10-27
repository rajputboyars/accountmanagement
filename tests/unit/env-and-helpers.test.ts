import { describe, expect, it } from "vitest";
import { maskPhone, validatePinStrength } from "@/modules/identity";
import { DemoOtpSender, Msg91OtpSender } from "@/modules/identity/otp-provider";
import { getAuthEnv, getDbEnv, isDemoMode } from "@/server/env";
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
    expect(() => getAuthEnv({ NODE_ENV: "production", OTP_PEPPER: pepper, SMS_PROVIDER: "msg91" })).toThrow(/MSG91_AUTH_KEY/);
    expect(getAuthEnv({ NODE_ENV: "production", OTP_PEPPER: pepper, SMS_PROVIDER: "msg91", MSG91_AUTH_KEY: "k".repeat(24), MSG91_TEMPLATE_ID: "tpl123" })).toMatchObject({ SMS_PROVIDER: "msg91", MSG91_OTP_VARIABLE: "otp" });
  });

  it("allows the on-screen demo sender only on a demo deployment", async () => {
    expect(() => getAuthEnv({ NODE_ENV: "production", OTP_PEPPER: pepper, SMS_PROVIDER: "demo" })).toThrow(/DEMO_MODE=true/);
    expect(getAuthEnv({ NODE_ENV: "production", OTP_PEPPER: pepper, SMS_PROVIDER: "demo", DEMO_MODE: "true" })).toMatchObject({ SMS_PROVIDER: "demo", DEMO_MODE: true });
    expect(await new DemoOtpSender().send({ phone: "9876543210", code: "654321" })).toEqual({ displayCode: "654321" });
    expect(isDemoMode({ DEMO_MODE: "true" })).toBe(true);
    expect(isDemoMode({})).toBe(false);
  });

  it("sends the code through MSG91's DLT template without logging it, and reports refusals", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reply = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    const config = { authKey: "k".repeat(24), templateId: "tpl123", otpVariable: "otp" };
    await new Msg91OtpSender(config, reply(200, { type: "success" })).send({ phone: "9876543210", code: "123456" });
    expect(calls[0]!.url).toBe("https://control.msg91.com/api/v5/flow");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ template_id: "tpl123", short_url: "0", recipients: [{ mobiles: "919876543210", otp: "123456" }] });
    expect((calls[0]!.init.headers as Record<string, string>).authkey).toBe(config.authKey);
    await expect(new Msg91OtpSender(config, reply(200, { type: "error", message: "bad template" })).send({ phone: "9876543210", code: "1" })).rejects.toThrow(/couldn't be sent/);
    await expect(new Msg91OtpSender(config, reply(401, {})).send({ phone: "9876543210", code: "1" })).rejects.toThrow(/couldn't be sent/);
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
