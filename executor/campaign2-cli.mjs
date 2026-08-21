#!/usr/bin/env node
import { main } from "./campaign2-daemon.mjs";

main().catch((error) => {
  process.stderr.write(
    `[${new Date().toISOString()}] ERROR ${error?.message ?? String(error)}\n`,
  );
  process.exitCode = 1;
});
