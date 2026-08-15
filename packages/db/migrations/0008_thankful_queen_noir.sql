CREATE TABLE "reports" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"pdf" "bytea",
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;