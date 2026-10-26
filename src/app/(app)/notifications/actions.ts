"use server";

import { revalidatePath } from "next/cache";
import { markNotificationsRead, setNotificationPreference } from "@/modules/identity";
import { requireSession } from "@/server/auth";

/** The person's own notifications only; the session decides whose rows change. */

export async function markReadAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  await markNotificationsRead(await requireSession(), id || undefined);
  revalidatePath("/notifications");
}

export async function setPreferenceAction(formData: FormData) {
  await setNotificationPreference(await requireSession(), String(formData.get("kind") ?? ""), formData.get("inApp") === "on");
  revalidatePath("/notifications");
}
