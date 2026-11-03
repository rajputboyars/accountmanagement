import { cache } from "react";
import { getUserLanguage } from "@/modules/identity";
import { DEFAULT_LANGUAGE, translateServerMessage, translatorFor, type Language } from "@/shared/i18n";
import { getCurrentSession } from "./auth";

/** The signed-in person's language, once per request. Signed out: the default. */
export const getLanguage = cache(async (): Promise<Language> => {
  const session = await getCurrentSession();
  return session ? getUserLanguage(session) : DEFAULT_LANGUAGE;
});

/** Translator for server components: `const t = await getT();`. Client components use `useT()`. */
export async function getT() {
  return translatorFor(await getLanguage());
}

/** Puts a server-written English message into the person's language. Never fails: errors must still show. */
export async function localizeServerMessage(message: string): Promise<string> {
  try {
    return translateServerMessage(message, await getLanguage());
  } catch {
    return message;
  }
}
