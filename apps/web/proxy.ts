import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

// Next 16 renamed the `middleware` file convention to `proxy`; this is the
// classic Supabase session-refresh middleware under the new name.
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * All request paths except static assets:
     * - _next/static, _next/image (build output)
     * - favicon.ico and common image files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
