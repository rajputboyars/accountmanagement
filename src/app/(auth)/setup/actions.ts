"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { runFirstTimeSetup } from "@/modules/settings";
import { toActionError } from "@/server/action-result";

export type SetupState = {
  error?: string;
  /** Echoed back so the form keeps what was typed. The setup token is never echoed. */
  values?: { shopName: string; stateCode: string; gstin: string; ownerName: string; ownerPhone: string };
};

export async function setupAction(_previous: SetupState, formData: FormData): Promise<SetupState> {
  const field = (name: string) => String(formData.get(name) ?? "").trim();
  const values = {
    shopName: field("shopName"),
    stateCode: field("stateCode"),
    gstin: field("gstin"),
    ownerName: field("ownerName"),
    ownerPhone: field("ownerPhone").replace(/\D/g, "").slice(-10),
  };
  try {
    await runFirstTimeSetup({ ...values, setupToken: String(formData.get("setupToken") ?? "") });
  } catch (error) {
    unstable_rethrow(error);
    return { error: toActionError(error).error, values };
  }
  redirect("/login?setup=done");
}
