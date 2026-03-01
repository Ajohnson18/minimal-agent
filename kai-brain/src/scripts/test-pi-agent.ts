/**
 * Test script for pi-agent integration
 * Run with: npx tsx src/scripts/test-pi-agent.ts
 */
import { getPiModel, getDefaultProvider, getDefaultModelId } from '../agent/pi-provider.js';
import { streamSimple } from '@mariozechner/pi-ai';

async function testPiAgent() {
  console.log('=== Pi-Agent Integration Test ===\n');

  // 1. Test provider configuration
  console.log('1. Provider Configuration:');
  const provider = getDefaultProvider();
  const modelId = getDefaultModelId();
  console.log(`   Provider: ${provider}`);
  console.log(`   Model: ${modelId}`);
  console.log(`   GOOGLE_CLOUD_PROJECT: ${process.env.GOOGLE_CLOUD_PROJECT || 'not set'}`);
  console.log(`   GOOGLE_CLOUD_LOCATION: ${process.env.GOOGLE_CLOUD_LOCATION || 'not set'}`);
  console.log(`   GOOGLE_APPLICATION_CREDENTIALS: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}`);
  console.log();

  // 2. Test model retrieval
  console.log('2. Getting model...');
  try {
    const model = getPiModel(provider, modelId);
    console.log(`   Success! Model: ${model.name}`);
    console.log();
  } catch (error) {
    console.error(`   FAILED: ${error}`);
    process.exit(1);
  }

  // 3. Test simple completion
  console.log('3. Testing simple completion...');
  try {
    const model = getPiModel(provider, modelId);
    const stream = streamSimple(model, {
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      messages: [
        {
          role: 'user',
          content: 'Say "Hello from pi-agent!" and nothing else.',
          timestamp: Date.now(),
        },
      ],
    });

    let response = '';
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        response += event.delta;
        process.stdout.write(event.delta);
      }
    }
    console.log('\n');
    console.log(`   Response: ${response.trim()}`);
    console.log('\n=== Test PASSED ===');
  } catch (error) {
    console.error(`\n   FAILED: ${error}`);
    process.exit(1);
  }
}

testPiAgent().catch(console.error);
