"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { addStaffMember, revokeStaffAccess, setOwnerPin, setStaffActive, updateStaffRole } from "@/modules/identity";
import { updateBusinessProfile, updateGstSettings, updateInvoiceSettings } from "@/modules/settings";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import type { RoleName } from "@/shared/permissions";

export type FormState = { ok?: boolean; error?: string; message?: string; nonce?: number };

/** Every action re-reads the session on the server; the services check permissions and shop scope. */

export async function addStaffAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSession();
    const member = await addStaffMember(session, {
      name: formData.get("name"),
      phone: String(formData.get("phone") ?? "").replace(/\D/g, "").slice(-10),
      role: formData.get("role"),
    });
    revalidatePath("/settings");
    return { ok: true, message: `${member.name} can now sign in with their mobile number.`, nonce: Date.now() };
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
}

export async function setStaffActiveAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSession();
    await setStaffActive(session, String(formData.get("userId") ?? ""), formData.get("active") === "true");
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
}

export async function setPinAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const pin = String(formData.get("pin") ?? "");
  if (pin !== String(formData.get("confirmPin") ?? "")) return { ok: false, error: "The two PINs don't match." };
  try {
    const session = await requireSession();
    await setOwnerPin(session, pin);
    revalidatePath("/settings");
    return { ok: true, message: "Approval PIN saved.", nonce: Date.now() };
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
}

export async function updateStaffRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSession();
    const userId = String(formData.get("userId") ?? "");
    const role = String(formData.get("role") ?? "") as RoleName;
    const member = await updateStaffRole(session, userId, role);
    revalidatePath("/settings");
    return { ok: true, message: `${member.name}'s role updated to ${member.role}. They were signed out to apply changes.`, nonce: Date.now() };
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
}

export async function revokeStaffAccessAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSession();
    const userId = String(formData.get("userId") ?? "");
    const result = await revokeStaffAccess(session, userId);
    revalidatePath("/settings");
    return { ok: true, message: `Signed out of ${result.revokedSessions} active session(s).`, nonce: Date.now() };
  } catch (error) {
    unstable_rethrow(error);
    return toActionError(error);
  }
}

// ── Business profile, GST and invoice settings (owner: `settings.edit`, checked by the service) ──

export type SettingsFormState = FormState & { values?: Record<string, string | string[]> };

async function saveSettings(save: () => Promise<void>, values: Record<string, string | string[]>, message: string): Promise<SettingsFormState> {
  try {
    await save();
  } catch (error) {
    unstable_rethrow(error);
    return { ...toActionError(error), values, nonce: Date.now() };
  }
  revalidatePath("/settings");
  return { ok: true, message, nonce: Date.now() };
}

const fields = (formData: FormData, names: string[]) => Object.fromEntries(names.map((name) => [name, String(formData.get(name) ?? "")]));

export async function saveProfileAction(_previous: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const values = fields(formData, ["name", "legalName", "address", "phone", "stateCode", "email", "pinCode"]);
  return saveSettings(async () => updateBusinessProfile(await requireSession(), values), values, "Business details saved. New bills will show them.");
}

export async function saveGstAction(_previous: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const values = { ...fields(formData, ["registration", "gstin", "interStateSales"]), gstRatesBp: formData.getAll("gstRatesBp").map(String) };
  return saveSettings(async () => updateGstSettings(await requireSession(), values), values, "GST settings saved. They apply to bills made from now on.");
}

export async function saveInvoiceAction(_previous: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const values = fields(formData, ["invoicePrefix", "startingNumber", "terms", "upiId", "bankDetails"]);
  return saveSettings(async () => updateInvoiceSettings(await requireSession(), values), values, "Invoice settings saved.");
}
