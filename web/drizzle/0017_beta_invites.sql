CREATE TABLE "beta_invites" (
	"email" text PRIMARY KEY NOT NULL,
	"invited_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
