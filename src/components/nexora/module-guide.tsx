import { finishedTips, loadPermissions } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { GUIDE_MODULES, tasksFor, type GuideModule } from "@/shared/guidance";
import { GuideSlot } from "./guide-slot";

/** Runs only after the page's own permission gate. A module the person may not use shows nothing. */
export async function ModuleGuide({ module }: { module: GuideModule }) {
  const session = await requireSession();
  const [granted, finished] = await Promise.all([loadPermissions(session), finishedTips(session)]);
  const { topic, permission, task } = GUIDE_MODULES[module];
  if (permission && !granted.has(permission)) return null;
  const allowedTask = task && tasksFor(granted).includes(task) ? task : null;
  return <GuideSlot module={module} topic={topic} firstVisit={!finished.has(module)} task={allowedTask} />;
}
