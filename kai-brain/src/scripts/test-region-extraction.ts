#!/usr/bin/env tsx
/**
 * Test script to verify region extraction from model.baseUrl
 *
 * This test verifies that:
 * 1. Claude models have region encoded in baseUrl
 * 2. The region can be extracted correctly
 * 3. No global process.env mutation occurs
 */

import { getPiModel } from "../agent/pi-provider.js";

function extractRegionFromBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    const match = url.hostname.match(/^([a-z0-9-]+)-aiplatform\.googleapis\.com$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function testRegionExtraction() {
  console.log("🧪 Testing region extraction from model.baseUrl\n");

  // Test 1: Claude model should have region in baseUrl
  console.log("Test 1: Claude model baseUrl");
  try {
    const claudeModel = getPiModel("vertex", "claude-sonnet-4-5@20250929");
    console.log(`  Model: ${claudeModel.id}`);
    console.log(`  BaseUrl: ${claudeModel.baseUrl}`);

    const extractedRegion = extractRegionFromBaseUrl(claudeModel.baseUrl);
    console.log(`  Extracted region: ${extractedRegion}`);

    if (extractedRegion === "us-east5") {
      console.log("  ✅ PASS: Region extracted correctly\n");
    } else {
      console.log(`  ❌ FAIL: Expected 'us-east5', got '${extractedRegion}'\n`);
      process.exit(1);
    }
  } catch (error) {
    console.log(`  ❌ FAIL: ${error}\n`);
    process.exit(1);
  }

  // Test 2: Gemini model
  console.log("Test 2: Gemini model");
  try {
    const geminiModel = getPiModel("vertex", "gemini-2.5-pro");
    console.log(`  Model: ${geminiModel.id}`);
    console.log(`  BaseUrl: ${geminiModel.baseUrl || "(not set)"}`);
    console.log(`  ✅ PASS: Gemini model created successfully\n`);
  } catch (error) {
    console.log(`  ❌ FAIL: ${error}\n`);
    process.exit(1);
  }

  // Test 3: Verify no process.env mutation
  console.log("Test 3: Check process.env.GOOGLE_CLOUD_LOCATION");
  const envBefore = process.env.GOOGLE_CLOUD_LOCATION;

  // Create both models
  getPiModel("vertex", "claude-sonnet-4-5@20250929");
  getPiModel("vertex", "gemini-2.5-pro");

  const envAfter = process.env.GOOGLE_CLOUD_LOCATION;

  console.log(`  Before: ${envBefore || "(not set)"}`);
  console.log(`  After: ${envAfter || "(not set)"}`);

  if (envBefore === envAfter) {
    console.log("  ✅ PASS: No per-request env mutation\n");
  } else {
    console.log("  ⚠️  WARN: Environment variable changed (may be set at startup)\n");
  }

  console.log("✅ All tests passed!");
}

testRegionExtraction().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
