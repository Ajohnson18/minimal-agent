CREATE TABLE IF NOT EXISTS "kai_settings" (
  "key" varchar(255) PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kai_onboarding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "step" integer NOT NULL,
  "question_key" varchar(255) NOT NULL UNIQUE,
  "label" text NOT NULL,
  "description" text,
  "input_type" varchar(50) DEFAULT 'text' NOT NULL,
  "options" text,
  "answer" text,
  "required" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kai_skill_tree_nodes" (
  "id" varchar(255) PRIMARY KEY,
  "label" varchar(255) NOT NULL,
  "description" text NOT NULL,
  "node_type" varchar(50) NOT NULL,
  "status" varchar(50) DEFAULT 'locked' NOT NULL,
  "branch" varchar(100),
  "parent_id" varchar(255),
  "credential_key" varchar(255),
  "requires_integration" varchar(255),
  "tools" jsonb DEFAULT '[]',
  "setup_tasks" jsonb DEFAULT '[]',
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO kai_settings (key, value) VALUES ('onboarded', 'false') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO kai_onboarding (step, question_key, label, description, input_type, required) VALUES
  (1, 'company_name',       'What''s the name of your company?',                                     NULL, 'text', true),
  (2, 'company_description','In a sentence or two, what does your company do?',                      NULL, 'textarea', true),
  (3, 'team_structure',     'Which teams does your company have?',                                   'e.g. Product, Engineering, Operations', 'text', false),
  (4, 'quarterly_goals',    'What are the most important things your team is focused on right now?', NULL, 'textarea', false),
  (5, 'kai_role',           'What role should Kai play on your team?',                               NULL, 'select', true),
  (6, 'kai_vibe',           'How should Kai communicate — what''s the vibe?',                        'e.g. sharp and direct, friendly, analytical', 'text', false),
  (7, 'your_name',          'What''s your name?',                                                    NULL, 'text', true),
  (8, 'team_tools',         'What tools does your team use?',                                        'Select the tools and services your team works with', 'multi-select', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE kai_onboarding SET options = '["Team Coworker","Engineering Assistant","Design Assistant","Product Assistant","Operations Helper"]' WHERE question_key = 'kai_role' AND options IS NULL;
--> statement-breakpoint
INSERT INTO kai_skill_tree_nodes (id, label, description, node_type, status, branch, parent_id, requires_integration, tools, setup_tasks, sort_order) VALUES
-- Brain
('brain', 'KAI', 'Core AI brain — language understanding, reasoning, memory, and tool orchestration.', 'brain', 'available', NULL, NULL, NULL,
 '[{"name":"memory","description":"Search, save, and recall long-term memories"},{"name":"read","description":"Read file contents"},{"name":"write","description":"Create or overwrite files"},{"name":"exec","description":"Run shell commands"}]',
 '[{"id":"brain-company","label":"Company name","detectKey":"onboard:company_name","required":true,"completed":false},{"id":"brain-description","label":"What the company does","detectKey":"onboard:company_description","required":true,"completed":false},{"id":"brain-teams","label":"Team structure","detectKey":"onboard:team_structure","required":false,"completed":false},{"id":"brain-goals","label":"Current focus areas","detectKey":"onboard:quarterly_goals","required":false,"completed":false},{"id":"brain-role","label":"Kai''s role","detectKey":"onboard:kai_role","required":true,"completed":false},{"id":"brain-vibe","label":"Kai''s vibe","detectKey":"onboard:kai_vibe","required":false,"completed":false},{"id":"brain-name","label":"Your name","detectKey":"onboard:your_name","required":true,"completed":false},{"id":"brain-tools","label":"What tools does your team use?","detectKey":"onboard:team_tools","required":true,"completed":false}]',
 0),
-- EDP branches only — integrations, tools, and skills are discovered by the AI on startup
('engineering', 'Engineering', 'Code, deploy, monitor. GitHub, CI/CD, databases, and infrastructure.', 'branch', 'locked', 'engineering', 'brain', NULL, '[]', '[]', 1),
('design', 'Design', 'Research, prototype, iterate. Figma, user testing, and design systems.', 'branch', 'locked', 'design', 'brain', NULL, '[]', '[]', 2),
('product', 'Product', 'Plan, track, ship. Linear, Notion, analytics, and roadmaps.', 'branch', 'locked', 'product', 'brain', NULL, '[]', '[]', 3),
('general', 'General', 'Core utilities — memory, time, session info, and general-purpose tools.', 'branch', 'locked', 'general', 'brain', NULL, '[]', '[]', 4)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kai_powers" (
  "id" varchar(255) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "description" text NOT NULL,
  "file_name" varchar(500) NOT NULL,
  "icon" varchar(50) DEFAULT '⚡' NOT NULL,
  "category" varchar(100) DEFAULT 'general' NOT NULL,
  "source" varchar(50) DEFAULT 'local' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "depends_on" jsonb DEFAULT '[]',
  "skills" jsonb DEFAULT '[]',
  "tools" jsonb DEFAULT '[]',
  "steps" jsonb DEFAULT '[]',
  "output" text DEFAULT '',
  "prompt" text DEFAULT '',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kai_power_runs" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "power_id" varchar(255) NOT NULL,
  "power_name" varchar(255) NOT NULL DEFAULT '',
  "run_id" varchar(255) NOT NULL,
  "session_id" varchar(255),
  "status" varchar(50) NOT NULL DEFAULT 'pending',
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "error" text,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kai_dashboard_metrics" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "power_id" varchar(255) NOT NULL,
  "power_name" varchar(255) NOT NULL DEFAULT '',
  "key" varchar(255) NOT NULL,
  "label" varchar(255) NOT NULL,
  "value" text NOT NULL,
  "unit" varchar(50),
  "type" varchar(50) NOT NULL DEFAULT 'number',
  "icon" varchar(50),
  "metadata" jsonb,
  "last_run_id" varchar(255),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kai_dashboard_metrics_power_key_idx" ON "kai_dashboard_metrics" USING btree ("power_id","key");
