import { Info } from "lucide-react";

/** Required on any screen that shows sample figures, so nobody mistakes them for real business data. */
export function DemoDataNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl border border-amber/40 bg-amber-soft px-4 py-3 text-sm text-amber-ink">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">Sample data.</span>{" "}
        {children ?? "These figures are examples for the preview. Nexora is not connected to a database yet."}
      </p>
    </div>
  );
}
