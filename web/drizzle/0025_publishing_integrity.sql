-- Publishing integrity corrections (review M-3): operator emergency stops are recorded here,
-- separately from each brand's own pause, so a brand admin's "Resume publishing" can't lift them.
-- Scope "all" or "org:<organisation id>"; only `npm run publishing:stop -- resume` removes a row.
CREATE TABLE "publishing_stops" (
	"scope" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
