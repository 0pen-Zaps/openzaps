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

Before release, run:

```sh
npm run test:relay-pg16
```

That harness starts a disposable PostgreSQL 16 cluster, replays the complete
OpenZaps migration chain twice, and exercises the final concurrency,
immutability, and privilege boundaries.
