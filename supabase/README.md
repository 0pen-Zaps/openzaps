# OpenZaps database migrations

Apply these files in timestamp order. The three historical filenames ending in
`zap_intents_relay`, `allow_recurring_relative_kind`, and
`zap_intents_executor` intentionally use the timestamps already recorded by the
production database.

The current production Supabase project is shared and contains older migration
rows owned by another application. Those rows are outside this repository:

- never `repair`, revert, delete, or rename an unrelated remote migration;
- do not assume a bare `supabase db push` from this checkout owns the project's
  complete history;
- apply only reviewed OpenZaps files, transactionally, and record only their
  exact timestamp and name in `supabase_migrations.schema_migrations`;
- verify the relevant tables, grants, triggers, counters, and OpenZaps history
  rows after every production application.

Production application storage is additionally bound in the server to
`OPENZAPS_SUPABASE_PROJECT_REF`: `SUPABASE_URL` must be exactly
`https://<OPENZAPS_SUPABASE_PROJECT_REF>.supabase.co`. Identifying a project in
the dashboard or CLI is not enough; confirm that exact host before running any
migration or setting a storage-backed feature flag.

Authenticated CLI verification on 1 August 2026 identified the production
shared project as `pool-fans-v2` with ref `jhzpyfzkdsyavgnnuzyu`, and
`20260801143000_marketing_x_mentions.sql` as the latest applied OpenZaps
migration before this release. The forward-only
`20260801214552_harden_subscription_authorization_grants.sql` migration must be
recorded separately after it is reviewed and applied. Treat all of this as
dated evidence: reverify the project and migration ledger before a write.
Setting the Vercel project-ref binding does not apply a migration or redeploy
the app.

`20260729095505_harden_verified_receipt_provenance.sql` deliberately stops if a
row claims `provenance_verified = true` without the complete canonical
provenance tuple. Do not delete, relabel, or guess values for immutable receipt
evidence. Reconcile any such row from independently verified chain evidence,
then rerun the migration.

Before release, run:

```sh
npm run test:relay-pg16
```

That harness starts a disposable PostgreSQL 16 cluster, replays the complete
OpenZaps migration chain twice, and exercises the final concurrency,
immutability, and privilege boundaries.
