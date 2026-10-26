import { ShieldCheck } from "lucide-react";
import { Logo } from "@/components/nexora/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background px-4 py-6 sm:px-6 lg:py-10">
      <div className="mx-auto grid w-full max-w-5xl gap-4 lg:min-h-[calc(100dvh-5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <aside className="flex flex-col justify-between gap-8 rounded-3xl bg-gradient-to-b from-panel to-panel-2 p-7 text-panel-foreground sm:p-10">
          <Logo className="[&_span]:text-panel-foreground" />
          <div className="flex flex-col gap-3">
            <h1 className="text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
              Your whole shop.
              <br />
              One clear screen.
            </h1>
            <p className="max-w-sm text-panel-muted">
              Billing, stock, customer dues and daily closing for Indian retail and wholesale businesses.
            </p>
          </div>
          <p className="flex items-center gap-2 text-sm text-panel-muted">
            <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
            Each person signs in with their own mobile number.
          </p>
        </aside>
        <main className="flex flex-col justify-center rounded-3xl border border-border bg-card p-6 shadow-[0_1px_2px_rgba(20,36,58,0.04)] sm:p-10">
          {children}
        </main>
      </div>
    </div>
  );
}
