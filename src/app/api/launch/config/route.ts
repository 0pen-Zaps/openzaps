import { getVerifiedRuntimeConfig } from "@/lib/zappad/server-config";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getVerifiedRuntimeConfig(), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "application/json; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
