import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Unknown address. Records of another shop also end up here or on a "not found" card, never revealed. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-semibold text-teal-strong">404</p>
      <h1 className="text-xl font-bold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">The address may be mistyped, or the record may belong to a different shop.</p>
      <Link href="/dashboard" className={buttonVariants({ size: "touch" })}>
        Go to dashboard
      </Link>
    </main>
  );
}
