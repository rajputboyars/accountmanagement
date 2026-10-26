"use client";

/** Last-resort error page when the root layout itself fails. Renders its own document; no app styles. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "Inter, system-ui, sans-serif", background: "#F7F9FC", color: "#14243A", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0, padding: 16 }}>
        <title>Nexora · Something went wrong</title>
        <main style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 20 }}>Nexora couldn&apos;t load</h1>
          <p style={{ fontSize: 14, color: "#475569" }}>Nothing was saved halfway. Please try again.</p>
          <button type="button" onClick={() => retry()} style={{ marginTop: 12, minHeight: 44, padding: "0 20px", borderRadius: 12, border: 0, background: "#0F766E", color: "#fff", fontSize: 14, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
