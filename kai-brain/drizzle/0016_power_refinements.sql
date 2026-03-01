ALTER TABLE "kai_powers" ADD COLUMN IF NOT EXISTS "refinements" text DEFAULT '';

CREATE TABLE IF NOT EXISTS "kai_power_versions" (
  "id" varchar(255) PRIMARY KEY,
  "power_id" varchar(255) NOT NULL,
  "prompt" text NOT NULL,
  "change_note" varchar(500) DEFAULT '',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "kai_power_versions_power_id_idx"
  ON "kai_power_versions" ("power_id", "created_at" DESC);
