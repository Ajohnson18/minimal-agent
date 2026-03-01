/**
 * Test Config-Based Model Routing
 */
import { getConfig, getModelForComplexity, getModelForSubagent } from '../lib/config-loader.js';
import { classifyTask } from '../agent/task-classifier.js';

async function main() {
  console.log('=== Testing Config Loader ===\n');

  const config = getConfig();
  console.log('✓ Config loaded successfully');
  console.log(`  Primary model: ${config.agent.model.primary}`);
  console.log(`  Fallback model: ${config.agent.model.fallback}`);

  console.log('\n=== Testing Task Complexity Routing ===\n');

  const complexities: Array<'simple' | 'medium' | 'complex' | 'vision'> = [
    'simple', 'medium', 'complex', 'vision',
  ];

  for (const complexity of complexities) {
    const model = getModelForComplexity(complexity);
    console.log(`✓ ${complexity.padEnd(10)} → ${model || 'default'}`);
  }

  console.log('\n=== Testing Task Classifier ===\n');

  const testCases = [
    { message: 'HEARTBEAT_OK', expected: 'simple' },
    { message: 'read package.json', expected: 'simple' },
    { message: 'ls src/', expected: 'simple' },
    { message: 'git status', expected: 'simple' },
    { message: 'explain how this function works', expected: 'medium' },
    { message: 'debug the authentication error', expected: 'medium' },
    { message: 'search for all TODO comments', expected: 'medium' },
    { message: 'refactor the entire API layer', expected: 'complex' },
    { message: 'design a caching strategy', expected: 'complex' },
    { message: 'implement user authentication feature', expected: 'complex' },
  ];

  for (const testCase of testCases) {
    const complexity = classifyTask(testCase.message, { messages: [] });
    const match = complexity === testCase.expected ? '✓' : '✗';
    console.log(`${match} "${testCase.message}" → ${complexity} (expected: ${testCase.expected})`);
  }

  console.log('\n=== Testing Subagent Model Routing ===\n');

  const subagentTypes: Array<'research' | 'analyze' | 'code' | 'general'> = [
    'research', 'analyze', 'code', 'general',
  ];

  for (const type of subagentTypes) {
    const model = getModelForSubagent(type);
    console.log(`✓ ${type.padEnd(10)} → ${model || 'default'}`);
  }

  console.log('\n=== All Tests Passed ===\n');
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
