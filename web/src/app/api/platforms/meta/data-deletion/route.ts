import { metaDataDeletion } from "@/server/platforms/meta-routes";

export const runtime = "nodejs";

/** Meta data-deletion callback (Meta App Dashboard: "Data deletion request URL"). */
export const POST = metaDataDeletion;
