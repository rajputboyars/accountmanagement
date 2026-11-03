"use client";

import { useTransition } from "react";
import { startGuideAction } from "@/app/(app)/guides/actions";
import { Button } from "@/components/ui/button";
import type { GuidedTaskKey } from "@/shared/guidance";

export function GuideStartButton({ task, restart, label }: { task: GuidedTaskKey; restart: boolean; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button type="button" size="touch" variant="outline" disabled={pending} onClick={() => start(() => startGuideAction(task, restart))}>
      {label}
    </Button>
  );
}
