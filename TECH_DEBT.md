# Technical Debt

## Deferred M0b workload tables

These four tables were audited in M0b and confirmed to be user_id-scoped only (no org_id column).
They must be migrated before any cross-org feature references them.
The migration pattern to follow is identical to `supabase/migration_m0b_meeting_notes.sql`:
additive (add nullable org_id FK, backfill from org_members, set NOT NULL, update RLS policy, add org index).
Create `supabase/migration_m0b_workload_tables.sql` when ready.

| Table             | What it is                                   | Blocks milestone          |
|-------------------|----------------------------------------------|---------------------------|
| briefing_items    | Daily briefing engine output rows per CSM    | M5 — org-level priority queue |
| outreach_queue    | AI-drafted outreach items per account        | M3 — close-out write-back |
| survey_schedules  | Per-user survey send schedule config         | M5 — org-level survey config |
| digest_schedules  | Per-user health digest schedule config       | M5 — org-level digest config |
