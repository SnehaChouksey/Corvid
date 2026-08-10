-- Structurally append-only audit log (ADR-16): rewrite any UPDATE/DELETE on audit_log to nothing,
-- so the accountability record can only ever be inserted to or read. This is enforced at the DB,
-- not just by the absence of a mutating repo function — a rogue query cannot alter history.
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
