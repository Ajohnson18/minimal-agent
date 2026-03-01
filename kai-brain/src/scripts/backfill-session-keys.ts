import { sessionKeyResolverService } from '../services/session-key-resolver.service.js';

async function main(): Promise<void> {
  let total = 0;

  for (;;) {
    const count = await sessionKeyResolverService.backfillMissingSessionKeys(500);
    total += count;
    if (count === 0) break;
  }

  process.stdout.write(`Backfilled session keys: ${total}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Session key backfill failed: ${message}\n`);
  process.exitCode = 1;
});
