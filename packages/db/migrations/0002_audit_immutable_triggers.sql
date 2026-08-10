-- Harden the append-only audit log (ADR-16). The earlier DO INSTEAD NOTHING rules made a blocked
-- UPDATE/DELETE look SUCCESSFUL (a failure that looks like success, forbidden by §4) and didn't
-- cover TRUNCATE. Replace them with triggers that RAISE loudly on any mutation, including TRUNCATE.
-- NOTE (prod hardening, follow-up): also REVOKE UPDATE/DELETE/TRUNCATE from the app role and run
-- the app as a non-owner, since the table owner can drop triggers — the GRANT is the durable control.
DROP RULE IF EXISTS audit_log_no_update ON audit_log;
DROP RULE IF EXISTS audit_log_no_delete ON audit_log;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION corvid_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (ADR-16): % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION corvid_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION corvid_audit_immutable();
