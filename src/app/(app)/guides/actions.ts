"use server";

import { revalidatePath } from "next/cache";
import { confirmGuidedTaskSaved, finishTip, pauseGuidedTask, setGuidedTaskStep, skipGuidedTask, startGuidedTask } from "@/modules/identity";
import { requireSession } from "@/server/auth";

/** Progress only. None of these touches a business record. */
export async function finishTipAction(module: string, status: "done" | "dismissed"): Promise<void> {
  await finishTip(await requireSession(), module, status === "done" ? "done" : "dismissed");
}

export async function startGuideAction(task: string, restart: boolean): Promise<void> {
  await startGuidedTask(await requireSession(), task, { restart });
  revalidatePath("/", "layout");
}

export async function setGuideStepAction(task: string, step: number): Promise<void> {
  await setGuidedTaskStep(await requireSession(), task, step);
}

export async function pauseGuideAction(task: string): Promise<void> {
  await pauseGuidedTask(await requireSession(), task);
  revalidatePath("/guides");
}

export async function skipGuideAction(task: string): Promise<void> {
  await skipGuidedTask(await requireSession(), task);
  revalidatePath("/guides");
}

export async function confirmGuideSavedAction(task: string): Promise<number | null> {
  const step = await confirmGuidedTaskSaved(await requireSession(), task);
  if (step !== null) revalidatePath("/guides");
  return step;
}
