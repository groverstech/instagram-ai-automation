CREATE TABLE "ai_controls" (
	"scope" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
