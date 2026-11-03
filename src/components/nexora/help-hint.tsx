"use client";

import { useId, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import { Info, X } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/nexora/language-provider";
import { helpContent, type HelpTopic } from "@/shared/i18n/help";

/**
 * A small information button beside a label or heading. Hover or keyboard focus shows the one-line meaning; click, tap,
 * Enter or Space opens the full explanation. It never sits inside a <label> or <a>; see Field and KpiCard.
 */
export function HelpHint({ topic, className }: { topic: HelpTopic; className?: string }) {
  const t = useT();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const content = helpContent(topic, t);
  if (!content) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Root disabled={open}>
        <Tooltip.Trigger
          delay={150}
          render={
            <Popover.Trigger
              render={
                <button
                  type="button"
                  aria-label={t("help.ui.open", { topic: content.title })}
                  aria-describedby={descriptionId}
                  data-help-topic={topic}
                  className={cn(
                    "relative inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full align-middle text-current opacity-60 transition-opacity after:absolute after:-inset-1 pointer-coarse:after:-inset-3 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-popup-open:opacity-100 print:hidden",
                    className,
                  )}
                />
              }
            />
          }
        >
          <Info className="size-4" aria-hidden="true" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={6} collisionPadding={8} className="z-[70]">
            <Tooltip.Popup
              data-help-tooltip=""
              className="max-w-[min(18rem,calc(100vw-1rem))] rounded-lg bg-foreground px-3 py-2 text-xs font-normal break-words text-background shadow-md"
            >
              {content.short}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      <span id={descriptionId} className="sr-only">
        {content.short}
      </span>
      <Popover.Portal>
        <Popover.Positioner side="bottom" sideOffset={8} collisionPadding={8} className="z-[70]">
          <Popover.Popup
            data-help-popup=""
            className="flex max-h-[min(var(--available-height),75vh)] w-[min(22rem,calc(100vw-1rem))] flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-popover p-4 text-left text-sm font-normal break-words text-popover-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3">
              <Popover.Title className="text-base font-semibold text-foreground">{content.title}</Popover.Title>
              <Popover.Close
                aria-label={t("common.close")}
                className="-mt-1 -mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-8"
              >
                <X className="size-4" aria-hidden="true" />
              </Popover.Close>
            </div>
            <Popover.Description render={<div className="flex flex-col gap-3" />}>
              <HelpPart heading={t("help.ui.what")} text={content.what} />
              <HelpPart heading={t("help.ui.when")} text={content.when} />
              <HelpPart heading={t("help.ui.example")} text={content.example} />
              {content.detail ? (
                <details className="rounded-lg bg-muted px-3 py-2">
                  <summary className="cursor-pointer font-medium text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{t("help.ui.more")}</summary>
                  <p className="mt-1.5 text-muted-foreground">{content.detail}</p>
                </details>
              ) : null}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function HelpPart({ heading, text }: { heading: string; text: string }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-foreground">{heading}</h3>
      <p className="text-muted-foreground">{text}</p>
    </div>
  );
}
