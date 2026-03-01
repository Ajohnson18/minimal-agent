/**
 * Quick test for typed control-envelope parsing.
 */
import { parseControlEnvelope, toDeliveryControl } from '../core/control-envelope.js';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Test suppress envelope behavior
console.log('Testing suppress control envelope...');
{
  const envelope = parseControlEnvelope('{"v":1,"action":"suppress","reason":"no-user-impact"}');
  const result = toDeliveryControl(envelope, 'fallback');
  assert(result.mode === 'suppress', 'Suppress action should suppress delivery');
}
console.log('✅ Suppress envelope tests passed');

// Test literal legacy tokens are now plain text and do not parse as control.
console.log('\nTesting legacy token literals are plain text...');
assert(parseControlEnvelope('NO_REPLY') === null, 'NO_REPLY should not parse as control');
assert(
  parseControlEnvelope('HEARTBEAT_OK') === null,
  'HEARTBEAT_OK should not parse as control',
);
console.log('✅ Legacy token literal tests passed');

// Test deliver envelope behavior.
console.log('\nTesting deliver control envelope...');
{
  const envelope = parseControlEnvelope('{"v":1,"action":"deliver","message":"done"}');
  const result = toDeliveryControl(envelope, 'fallback');
  assert(result.mode === 'deliver', 'Deliver action should produce deliver mode');
  if (result.mode === 'deliver') {
    assert(result.text === 'done', 'Deliver action should keep envelope message');
  }
}
console.log('✅ Deliver envelope tests passed');

console.log('\n✅ All tests passed!');
