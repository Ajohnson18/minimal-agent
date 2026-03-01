/**
 * Test script for subagent functionality
 *
 * Run with: npx tsx src/scripts/test-subagent.ts
 */
import { spawnSubagent, isSubagentSession } from '../agent/subagent-executor.js';
import { db } from '../db/client.js';
import { avaSessions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

async function runTests() {
  console.log('=== Subagent Test Suite ===\n');

  // Test 1: Create a test parent session
  console.log('Test 1: Create test parent session');
  const parentSessionId = randomUUID();
  const testUserId = 'test-user-subagent';

  await db.insert(avaSessions).values({
    id: parentSessionId,
    userId: testUserId,
    title: 'Test Parent Session',
    source: 'web',
    status: 'active',
  });
  console.log(`  ✓ Created parent session: ${parentSessionId}`);

  const isSubagent = await isSubagentSession(parentSessionId);
  console.log(`  ✓ isSubagentSession(parent): ${isSubagent} (expected: false)`);
  console.log('');

  // Test 2: Spawn a subagent (no type required)
  console.log('Test 2: Spawn subagent with tool access');
  console.log('  Task: List and count files in src/agent directory');
  console.log('  (This may take up to 60 seconds...)\n');

  const startTime = Date.now();
  const result = await spawnSubagent({
    task: 'Use the ls tool to list the files in the src/agent directory. Then tell me how many TypeScript files are there.',
    parentSessionId,
    userId: testUserId,
    cleanup: true,
    timeoutMs: 60000,
  });
  const elapsed = Date.now() - startTime;

  console.log(`  Completed in ${elapsed}ms`);
  console.log(`  Success: ${result.success}`);
  console.log(`  Tools used: ${result.toolsUsed.join(', ') || 'none'}`);
  console.log(`  Duration: ${result.durationMs}ms`);

  if (result.success) {
    console.log('\n  --- Subagent Response ---');
    console.log(result.content.split('\n').map(line => `  ${line}`).join('\n'));
    console.log('  --- End Response ---\n');
  } else {
    console.log(`  Error: ${result.error}`);
  }

  // Test 3: Verify cleanup happened
  console.log('Test 3: Verify session cleanup');
  const [cleanedSession] = await db
    .select()
    .from(avaSessions)
    .where(eq(avaSessions.id, result.sessionId))
    .limit(1);

  if (!cleanedSession) {
    console.log('  ✓ Subagent session was cleaned up');
  } else {
    console.log('  ✗ Subagent session still exists (cleanup failed)');
  }
  console.log('');

  // Test 4: Spawn with custom model and timeout
  console.log('Test 4: Spawn with custom timeout');
  const result2 = await spawnSubagent({
    task: 'What is 2 + 2? Just answer the number.',
    parentSessionId,
    userId: testUserId,
    cleanup: true,
    timeoutMs: 30000,
    label: 'quick-math',
  });

  console.log(`  Success: ${result2.success}`);
  console.log(`  Duration: ${result2.durationMs}ms`);
  if (result2.success) {
    console.log(`  Answer: ${result2.content.slice(0, 100)}`);
  }
  console.log('');

  // Cleanup
  console.log('Cleanup: Deleting test parent session');
  await db.delete(avaSessions).where(eq(avaSessions.id, parentSessionId));
  console.log('  ✓ Deleted parent session');

  console.log('\n=== All Tests Complete ===');
  process.exit(0);
}

runTests().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
