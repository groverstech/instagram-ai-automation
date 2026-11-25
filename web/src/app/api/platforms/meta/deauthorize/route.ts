import { metaDeauthorize } from "@/server/platforms/meta-routes";

export const runtime = "nodejs";

/** Meta deauthorise callback (Meta App Dashboard: "Deauthorize callback URL"). */
export const POST = metaDeauthorize;
