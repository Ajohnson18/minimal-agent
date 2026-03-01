-- Create new dashboard artifacts table (replaces kai_dashboard_metrics)
CREATE TABLE IF NOT EXISTS "kai_dashboard_artifacts" (
  "id" varchar(255) PRIMARY KEY,
  "power_id" varchar(255) NOT NULL,
  "power_name" varchar(255) NOT NULL DEFAULT '',
  "key" varchar(255) NOT NULL,
  "label" varchar(255) NOT NULL,
  "artifact_type" varchar(50) NOT NULL DEFAULT 'number',
  "data" jsonb NOT NULL DEFAULT '{}',
  "icon" varchar(50),
  "last_run_id" varchar(255),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "kai_dashboard_artifacts_power_key_idx"
  ON "kai_dashboard_artifacts" ("power_id", "key");

-- Migrate existing metrics into artifacts
INSERT INTO "kai_dashboard_artifacts" ("id", "power_id", "power_name", "key", "label", "artifact_type", "data", "icon", "last_run_id", "updated_at", "created_at")
SELECT
  "id",
  "power_id",
  "power_name",
  "key",
  "label",
  'number',
  jsonb_build_object('value', "value", 'unit', "unit"),
  "icon",
  "last_run_id",
  "updated_at",
  "created_at"
FROM "kai_dashboard_metrics"
ON CONFLICT ("id") DO NOTHING;

-- Add artifacts + previousPrompt + locked columns to kai_powers
ALTER TABLE "kai_powers" ADD COLUMN IF NOT EXISTS "artifacts" jsonb DEFAULT '[]';
ALTER TABLE "kai_powers" ADD COLUMN IF NOT EXISTS "previous_prompt" text DEFAULT '';
ALTER TABLE "kai_powers" ADD COLUMN IF NOT EXISTS "locked" boolean DEFAULT false NOT NULL;

-- Drop old table
DROP TABLE IF EXISTS "kai_dashboard_metrics";
