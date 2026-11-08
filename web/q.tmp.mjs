import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
const db = new PGlite(process.argv[2], { extensions: { vector } });
const r = await db.query(`select id, kind, visual_source, source_asset_id, image_path, image_error, image_provider from creatives order by created_at`);
console.table(r.rows);
const a = await db.query(`select id,name,kind,status,mime,path from brand_assets`);
console.table(a.rows);
