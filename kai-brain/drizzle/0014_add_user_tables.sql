CREATE TABLE "ava_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(255),
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"credentials" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ava_user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ava_user_identities" ADD CONSTRAINT "ava_user_identities_user_id_ava_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."ava_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_identities_provider_external" ON "ava_user_identities" USING btree ("provider","external_id");
--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "ava_user_identities" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_ava_users_role" ON "ava_users" USING btree ("role");
