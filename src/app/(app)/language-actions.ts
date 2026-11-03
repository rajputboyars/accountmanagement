"use server";

import { revalidatePath } from "next/cache";
import { setUserLanguage } from "@/modules/identity";
import { toActionError, type ActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";

/** Saves the language on the person's account, then re-renders the current screen in it. */
export async function setLanguageAction(language: string): Promise<{ ok: true } | ActionError> {
  try {
    await setUserLanguage(await requireSession(), language);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
