/**
 * System Events Integration Test
 *
 * Real test that requires DATABASE_URL to be set.
 * Tests actual database operations, deduplication, and event processing.
 */
import { systemEventsService } from '../services/system-events.service.js';
import { notificationDeduplicator } from '../services/notification-deduplicator.js';

async function runTests() {
  console.log('=== System Events Integration Test ===\n');

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set. Cannot run integration tests.');
    console.log('\nThis test requires a real database connection.');
    console.log('Set DATABASE_URL in your environment to run these tests.\n');
    process.exit(1);
  }

  try {
    // Test 1: Create an event
    console.log('Test 1: Create system event...');
    const event1 = await systemEventsService.create({
      sessionId: 'test-session-1',
      kind: 'exec.completion',
      payload: {
        text: 'Test exec completed',
      },
      contextKey: 'exec:test-123',
      metadata: { exitCode: 0 },
    });
    console.log(`✓ Event created: ${event1.id}\n`);

    // Test 2: Deduplication - should prevent duplicate
    console.log('Test 2: Attempt to create duplicate event...');
    const result = await notificationDeduplicator.checkAndCreate({
      sessionId: 'test-session-1',
      kind: 'exec.completion',
      payload: {
        text: 'Test exec completed',
      },
      contextKey: 'exec:test-123',
      metadata: { exitCode: 0 },
    });
    
    if (result.isDuplicate) {
      console.log('✓ Duplicate correctly prevented\n');
    } else {
      console.log('❌ Deduplication failed - duplicate was created\n');
      process.exit(1);
    }

    // Test 3: Retrieve pending events
    console.log('Test 3: Retrieve pending events...');
    const pending = await systemEventsService.getPendingEvents('test-session-1');
    console.log(`✓ Found ${pending.length} pending event(s)\n`);

    // Test 4: Mark as processed
    console.log('Test 4: Mark event as processed...');
    const marked = await systemEventsService.markProcessed(event1.id);
    if (marked) {
      console.log('✓ Event marked as processed\n');
    } else {
      console.log('❌ Failed to mark event as processed\n');
      process.exit(1);
    }

    // Test 5: Create another event after 60s window (would need to wait)
    console.log('Test 5: Create event with different context key...');
    const event2 = await systemEventsService.create({
      sessionId: 'test-session-1',
      kind: 'subagent.completion',
      payload: {
        text: 'Test subagent completed',
      },
      contextKey: 'subagent:test-456',
      metadata: { status: 'completed' },
    });
    console.log(`✓ Second event created: ${event2.id}\n`);

    // Test 6: Event stats
    console.log('Test 6: Get event statistics...');
    const stats = await systemEventsService.getStats();
    console.log(`✓ Stats: ${stats.totalEvents} total, ${stats.pendingEvents} pending\n`);

    // Test 7: Cleanup (mark second event as processed so cleanup can test)
    console.log('Test 7: Cleanup test events...');
    await systemEventsService.markProcessed(event2.id);
    const deleted = await systemEventsService.deleteSessionEvents('test-session-1');
    console.log(`✓ Cleaned up ${deleted} test event(s)\n`);

    console.log('=== All Tests Passed ✅ ===\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

runTests();
