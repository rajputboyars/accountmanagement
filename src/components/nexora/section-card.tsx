import { cn } from "cn";
import { HelpHint } from "@/components/nexora/help-hint";
import type { HelpTopic } from "@/shared/i18n/help";

type SectionCardProps = {
  title: string;
  description?: string;
  /** Puts an information button beside the title. */
  help?: HelpTopic;
  action?: React.ReactNode;
  className?: string;
  /** A fixed id for links to this section; needed when the title is translated. */
  anchorId?: string;
  /** Set when the content (such as a table) should run edge to edge. */
  flush?: boolean;
  children: React.ReactNode;
};

export function SectionCard({ title, description, help, action, anchorId, className, flush = false, children }: SectionCardProps) {
  // Links jump to a section by this id, so a translated title passes a fixed anchorId.
  const headingId = anchorId ?? `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(20,36,58,0.04)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <h2 id={headingId} className="text-base font-semibold text-foreground">
              {title}
            </h2>
            {help ? <HelpHint topic={help} className="text-muted-foreground" /> : null}
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className={cn("flex-1", flush ? "pb-2" : "px-5 pb-5")}>{children}</div>
    </section>
  );
}
