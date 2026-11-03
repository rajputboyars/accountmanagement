import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hasAuditSince } from "@/modules/audit";
import { getDb, withTransaction } from "@/server/db";
import { GUIDE_MODULE_KEYS, GUIDED_TASK_KEYS, GUIDED_TASKS, saveStepIndex, type GuideModule, type GuidedTaskKey } from "@/shared/guidance";
import { requirePermission } from "./authorization";
import { userGuidance, type UserGuidanceStatus } from "./schema";
import type { SessionContext } from "./sessions";

/**
 * Who has seen which tip and how far they got in each guided task. Per person and shop, whatever the language or device.
 * Nothing here is a business record, so these rows carry no audit entry; they hold task and step, never form contents.
 */
export type TaskStatus = Extract<UserGuidanceStatus, "in_progress" | "paused" | "skipped" | "completed">;
export type TaskProgress = { key: GuidedTaskKey; status: TaskStatus; step: number; everCompleted: boolean };

const moduleSchema = z.enum(GUIDE_MODULE_KEYS as [GuideModule, ...GuideModule[]]);
const taskSchema = z.enum(GUIDED_TASK_KEYS);

const mine = (session: SessionContext, kind: "tip" | "task") => and(eq(userGuidance.shopId, session.shopId), eq(userGuidance.userId, session.userId), eq(userGuidance.kind, kind));

/** The first-time tips this person has finished or dismissed. */
export async function finishedTips(session: SessionContext): Promise<Set<string>> {
  const rows = await getDb().select({ key: userGuidance.key }).from(userGuidance).where(mine(session, "tip"));
  return new Set(rows.map((row) => row.key));
}

/** Records "Got it" or a dismissal. The first answer stands, and repeating it changes nothing. */
export async function finishTip(session: SessionContext, moduleInput: unknown, status: Extract<UserGuidanceStatus, "done" | "dismissed">): Promise<void> {
  const key = moduleSchema.parse(moduleInput);
  await withTransaction((tx) =>
    tx.insert(userGuidance).values({ shopId: session.shopId, userId: session.userId, kind: "tip", key, status }).onConflictDoNothing(),
  );
}

export async function taskProgress(session: SessionContext): Promise<TaskProgress[]> {
  const rows = await getDb().select().from(userGuidance).where(mine(session, "task")).orderBy(desc(userGuidance.updatedAt));
  return rows.flatMap((row) => {
    const parsed = taskSchema.safeParse(row.key);
    return parsed.success ? [{ key: parsed.data, status: row.status as TaskStatus, step: row.step, everCompleted: row.completedAt !== null }] : [];
  });
}

async function requireTask(session: SessionContext, key: GuidedTaskKey) {
  for (const permission of GUIDED_TASKS[key].permissions) await requirePermission(session, permission);
}

/** Starts a task, or carries on from the saved step when it was paused. Replay starts again. Only one runs at a time. */
export async function startGuidedTask(session: SessionContext, input: unknown, options: { restart?: boolean } = {}): Promise<TaskProgress> {
  const key = taskSchema.parse(input);
  await requireTask(session, key);
  return withTransaction(async (tx) => {
    await tx.update(userGuidance).set({ status: "paused", updatedAt: sql`now()` }).where(and(mine(session, "task"), eq(userGuidance.status, "in_progress")));
    const [existing] = await tx.select().from(userGuidance).where(and(mine(session, "task"), eq(userGuidance.key, key)));
    const resume = existing && !options.restart && (existing.status === "paused" || existing.status === "in_progress");
    const step = resume ? existing.step : 0;
    // A save only counts from the first start of this run, so resuming keeps its window and replaying opens a new one.
    const [row] = await tx
      .insert(userGuidance)
      .values({ shopId: session.shopId, userId: session.userId, kind: "task", key, status: "in_progress", step, startedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [userGuidance.userId, userGuidance.kind, userGuidance.key],
        set: { status: "in_progress", step, updatedAt: sql`now()`, ...(resume ? {} : { startedAt: sql`now()` }) },
      })
      .returning();
    return { key, status: "in_progress", step, everCompleted: row!.completedAt !== null };
  });
}

/** Moves within a running task. It can't pass the save step: only confirmGuidedTaskSaved does that. */
export async function setGuidedTaskStep(session: SessionContext, input: unknown, stepInput: unknown): Promise<number> {
  const key = taskSchema.parse(input);
  const step = z.number().int().min(0).max(saveStepIndex(key)).parse(stepInput);
  await withTransaction((tx) =>
    tx.update(userGuidance).set({ step, updatedAt: sql`now()` }).where(and(mine(session, "task"), eq(userGuidance.key, key), eq(userGuidance.status, "in_progress"))),
  );
  return step;
}

/** Exit: stop showing it and keep the step, to resume later. */
export async function pauseGuidedTask(session: SessionContext, input: unknown): Promise<void> {
  const key = taskSchema.parse(input);
  await withTransaction((tx) => tx.update(userGuidance).set({ status: "paused", updatedAt: sql`now()` }).where(and(mine(session, "task"), eq(userGuidance.key, key), eq(userGuidance.status, "in_progress"))));
}

/** Skip: not interested for now. It can still be started again from the guides page. */
export async function skipGuidedTask(session: SessionContext, input: unknown): Promise<void> {
  const key = taskSchema.parse(input);
  await withTransaction((tx) => tx.update(userGuidance).set({ status: "skipped", step: 0, updatedAt: sql`now()` }).where(and(mine(session, "task"), eq(userGuidance.key, key), eq(userGuidance.status, "in_progress"))));
}

/** Has this person's real workflow saved the record since this run started? Read-only. */
export async function isGuidedTaskSaved(session: SessionContext, input: unknown): Promise<boolean> {
  const key = taskSchema.parse(input);
  const [row] = await getDb().select().from(userGuidance).where(and(mine(session, "task"), eq(userGuidance.key, key), eq(userGuidance.status, "in_progress")));
  if (!row?.startedAt) return false;
  return hasAuditSince({ shopId: session.shopId, userId: session.userId, action: GUIDED_TASKS[key].auditAction, since: row.startedAt });
}

/** Completes the task only when the audit log shows the real save happened. Returns the confirmation step, or null. */
export async function confirmGuidedTaskSaved(session: SessionContext, input: unknown): Promise<number | null> {
  const key = taskSchema.parse(input);
  if (!(await isGuidedTaskSaved(session, key))) return null;
  const step = GUIDED_TASKS[key].steps.length - 1;
  await withTransaction((tx) =>
    tx.update(userGuidance).set({ status: "completed", step, completedAt: sql`now()`, updatedAt: sql`now()` }).where(and(mine(session, "task"), eq(userGuidance.key, key), eq(userGuidance.status, "in_progress"))),
  );
  return step;
}
