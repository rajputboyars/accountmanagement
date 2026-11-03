"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { CircleHelp, Lightbulb, X } from "lucide-react";
import { finishTipAction, startGuideAction } from "@/app/(app)/guides/actions";
import { HelpHint } from "@/components/nexora/help-hint";
import { useT } from "@/components/nexora/language-provider";
import { Button } from "@/components/ui/button";
import { taskTitleKey, type GuideModule, type GuidedTaskKey } from "@/shared/guidance";
import { helpContent, type HelpTopic } from "@/shared/i18n/help";

/**
 * Sits above a module's page. The first time: a small card, never blocking. Afterwards: one quiet line that keeps
 * the same explanation (through the help popup) and the guided task within reach.
 */
export function GuideSlot({ module, topic, firstVisit, task }: { module: GuideModule; topic: HelpTopic; firstVisit: boolean; task: GuidedTaskKey | null }) {
  const t = useT();
  const [open, setOpen] = useState(firstVisit);
  const [more, setMore] = useState(false);
  const [starting, startTransition] = useTransition();
  const line = useRef<HTMLDivElement>(null);
  const content = helpContent(topic, t);
  if (!content) return null;

  const finish = (status: "done" | "dismissed") => {
    setOpen(false);
    void finishTipAction(module, status);
    requestAnimationFrame(() => line.current?.focus());
  };
  const startTask = () => task && startTransition(() => startGuideAction(task, false));

  return (
    <div className="mx-auto -mb-3 w-full max-w-[1440px] px-4 pt-4 sm:px-6 lg:px-8 print:hidden">
      {open ? (
        <section aria-label={content.title} data-first-time-guide={module} className="relative flex flex-col gap-2 rounded-2xl border border-teal/40 bg-card p-4 pr-12 text-sm shadow-[0_1px_2px_rgba(20,36,58,0.04)]">
          <h2 className="flex items-center gap-2 font-semibold text-foreground">
            <Lightbulb className="size-4 shrink-0 text-teal" aria-hidden="true" />
            {content.title}
          </h2>
          <p className="text-muted-foreground">{content.what}</p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{t("help.ui.when")} </span>
            {content.when}
          </p>
          {more ? (
            <div id={`guide-more-${module}`} className="flex flex-col gap-2 text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{t("help.ui.example")}: </span>
                {content.example}
              </p>
              {content.detail ? <p>{content.detail}</p> : null}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button type="button" size="touch" onClick={() => finish("done")}>
              {t("guide.ui.gotIt")}
            </Button>
            <Button type="button" size="touch" variant="ghost" aria-expanded={more} aria-controls={`guide-more-${module}`} onClick={() => setMore((value) => !value)}>
              {t(more ? "guide.ui.readLess" : "guide.ui.readMore")}
            </Button>
          </div>
          <button
            type="button"
            aria-label={t("guide.ui.skipTip")}
            onClick={() => finish("dismissed")}
            className="absolute top-1.5 right-1.5 inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </section>
      ) : (
        <div ref={line} tabIndex={-1} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground outline-none" data-guide-line={module}>
          <span className="flex items-center gap-1">
            {t("guide.ui.aboutScreen")}
            <HelpHint topic={topic} />
          </span>
          <span className="flex flex-wrap items-center gap-x-3">
            {task ? (
              <button type="button" disabled={starting} onClick={startTask} data-guide-start={task} className="inline-flex min-h-8 items-center gap-1 rounded font-medium text-teal hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11">
                <CircleHelp className="size-3.5" aria-hidden="true" />
                {t("guide.ui.showMe", { task: t(taskTitleKey(task)) })}
              </button>
            ) : null}
            <Link href="/guides" className="inline-flex min-h-8 items-center rounded hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11">
              {t("guide.ui.allGuides")}
            </Link>
          </span>
        </div>
      )}
    </div>
  );
}
