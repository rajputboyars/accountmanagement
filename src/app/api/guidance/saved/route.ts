import { NextResponse, type NextRequest } from "next/server";
import { isGuidedTaskSaved } from "@/modules/identity";
import { getCurrentSession } from "@/server/auth";
import { isGuidedTaskKey } from "@/shared/guidance";

/** Read-only check while a guide waits on a save. A route, not a server action, so it never queues behind the real form. */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ saved: false }, { status: 401 });
  const task = request.nextUrl.searchParams.get("task") ?? "";
  if (!isGuidedTaskKey(task)) return NextResponse.json({ saved: false }, { status: 400 });
  return NextResponse.json({ saved: await isGuidedTaskSaved(session, task) }, { headers: { "Cache-Control": "no-store" } });
}
