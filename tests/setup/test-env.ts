import { randomBytes } from "node:crypto";

// Test-only secrets, random per run. Real values belong only in a local, uncommitted .env.
process.env.OTP_PEPPER = randomBytes(32).toString("hex");
process.env.SETUP_TOKEN = randomBytes(32).toString("hex");
process.env.SMS_PROVIDER = "console";
process.env.SESSION_COOKIE_NAME = "nx_session";
