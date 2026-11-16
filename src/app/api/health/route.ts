/**
 * Liveness probe for deploy checks and uptime monitors.
 *
 * Deliberately returns nothing about configuration, versions or dependencies: it only
 * proves the Next.js server is up and answering requests. It never touches the database
 * or any secret.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
