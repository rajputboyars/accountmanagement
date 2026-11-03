import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { getDb, withTransaction } from "@/server/db";
import { LANGUAGES, normalizeLanguage, type Language } from "@/shared/i18n/languages";
import type { SessionContext } from "./sessions";
import { users } from "./schema";

const languageSchema = z.enum(LANGUAGES, { error: "Choose a language." });

/** This person's saved language; it follows them to every device. */
export async function getUserLanguage(session: SessionContext): Promise<Language> {
  const [row] = await getDb().select({ language: users.language }).from(users).where(and(eq(users.id, session.userId), eq(users.shopId, session.shopId))).limit(1);
  return normalizeLanguage(row?.language);
}

/** Changes the language for the person themselves only; audited. */
export async function setUserLanguage(session: SessionContext, input: unknown): Promise<Language> {
  const language = languageSchema.parse(input);
  await withTransaction(async (tx) => {
    await tx.update(users).set({ language }).where(and(eq(users.id, session.userId), eq(users.shopId, session.shopId)));
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, { action: "identity.language_set", entityType: "user", entityId: session.userId, after: { language } });
  });
  return language;
}
