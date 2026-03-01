import { pgTable, varchar, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export type ArtifactType = "number" | "text" | "table" | "image" | "links" | "report" | "chart";

export interface NumberArtifactData {
  value: string;
  unit?: string;
}

export interface TextArtifactData {
  content: string;
}

export interface TableArtifactData {
  columns: string[];
  rows: string[][];
}

export interface ImageArtifactData {
  url: string;
  alt?: string;
}

export interface LinksArtifactData {
  items: Array<{ url: string; label: string; description?: string }>;
}

export interface ReportArtifactData {
  summary: string;
  sections: Array<{ heading: string; content: string; severity?: "info" | "warning" | "critical" }>;
}

export interface ChartArtifactData {
  chartType: "bar" | "line" | "area" | "pie" | "stacked-bar";
  labels: string[];
  series: Array<{
    name: string;
    values: number[];
    color?: string;
  }>;
}

export type ArtifactData =
  | NumberArtifactData
  | TextArtifactData
  | TableArtifactData
  | ImageArtifactData
  | LinksArtifactData
  | ReportArtifactData
  | ChartArtifactData;

export const kaiDashboardArtifacts = pgTable("kai_dashboard_artifacts", {
  id: varchar("id", { length: 255 }).primaryKey(),
  powerId: varchar("power_id", { length: 255 }).notNull(),
  powerName: varchar("power_name", { length: 255 }).notNull().default(""),
  key: varchar("key", { length: 255 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  artifactType: varchar("artifact_type", { length: 50 }).notNull().default("number"),
  data: jsonb("data").notNull().$type<ArtifactData>(),
  icon: varchar("icon", { length: 50 }),
  lastRunId: varchar("last_run_id", { length: 255 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  powerKeyIdx: uniqueIndex("kai_dashboard_artifacts_power_key_idx").on(table.powerId, table.key),
}));

export type KaiDashboardArtifact = typeof kaiDashboardArtifacts.$inferSelect;
