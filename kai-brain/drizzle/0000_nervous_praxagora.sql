CREATE TABLE "ava_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" varchar(500),
	"external_id" varchar(255),
	"source" varchar(50) DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "ava_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" varchar(50) NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"tool_call_id" varchar(255),
	"name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_count" integer,
	"is_compacted" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "ava_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"source" varchar(100) NOT NULL,
	"source_id" uuid,
	"importance" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "ava_compaction_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"messages_compacted" integer NOT NULL,
	"tokens_before" integer NOT NULL,
	"tokens_after" integer NOT NULL,
	"first_message_id" uuid,
	"last_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ava_tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid,
	"user_id" varchar(255) NOT NULL,
	"tool_name" varchar(255) NOT NULL,
	"tool_input" jsonb,
	"tool_output" jsonb,
	"duration_ms" integer,
	"status" varchar(50) NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ava_messages" ADD CONSTRAINT "ava_messages_session_id_ava_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ava_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ava_compaction_history" ADD CONSTRAINT "ava_compaction_history_session_id_ava_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ava_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ava_tool_executions" ADD CONSTRAINT "ava_tool_executions_session_id_ava_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ava_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ava_tool_executions" ADD CONSTRAINT "ava_tool_executions_message_id_ava_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ava_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ava_sessions_user_id" ON "ava_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ava_sessions_updated" ON "ava_sessions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_ava_sessions_status" ON "ava_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ava_sessions_external_id" ON "ava_sessions" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_ava_messages_session" ON "ava_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_ava_messages_created" ON "ava_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ava_messages_role" ON "ava_messages" USING btree ("session_id","role");--> statement-breakpoint
CREATE INDEX "idx_ava_memory_user" ON "ava_memory" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ava_memory_importance" ON "ava_memory" USING btree ("user_id","importance");--> statement-breakpoint
CREATE INDEX "idx_ava_compaction_session" ON "ava_compaction_history" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_ava_tool_exec_session" ON "ava_tool_executions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_ava_tool_exec_user" ON "ava_tool_executions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ava_tool_exec_tool" ON "ava_tool_executions" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "idx_ava_tool_exec_created" ON "ava_tool_executions" USING btree ("created_at");