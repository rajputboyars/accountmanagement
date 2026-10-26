import type { Instrumentation } from "next";

/**
 * Server error logging: one JSON line per unhandled request error, picked up by the host's log drain
 * (Vercel → Log Drains, or any stdout collector). Messages can contain customer data (phone numbers,
 * SQL parameters), so production logs carry only the error name, Postgres code, digest (shown to the
 * user on the error page) and the route, never the message, query string or body.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const err = error as { name?: string; digest?: string; code?: string; cause?: { code?: string }; message?: string };
  const entry = {
    level: "error",
    event: "request_error",
    at: new Date().toISOString(),
    digest: err.digest ?? null,
    name: err.name ?? typeof error,
    pgCode: err.code ?? err.cause?.code ?? null,
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    routeType: context.routeType,
    ...(process.env.NODE_ENV === "production" ? {} : { message: err.message ?? String(error) }),
  };
  console.error(JSON.stringify(entry));
};
