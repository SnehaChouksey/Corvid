ALTER TABLE "hypotheses" ADD COLUMN "plan" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "hypotheses_scan_id_fingerprint_key" ON "hypotheses" USING btree ("scan_id","fingerprint");