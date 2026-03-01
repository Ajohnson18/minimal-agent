export type PowerSource = "local" | "custom" | "community";

export interface PowerArtifactDeclaration {
  key: string;
  label: string;
  type: string;
}

export interface PowerDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  source: PowerSource;
  skills: string[];
  tools: string[];
  dependsOn: string[];
  output: string;
  steps: string[];
  artifacts: PowerArtifactDeclaration[];
  prompt: string;
  refinements: string;
  previousPrompt: string;
  locked: boolean;
  filePath: string;
}

export interface PowerInfo {
  id: string;
  name: string;
  description: string;
  fileName: string;
  icon: string;
  category: string;
  source: PowerSource;
  enabled: boolean;
  dependsOn: string[];
  skills: string[];
  tools: string[];
  steps: string[];
  artifacts: PowerArtifactDeclaration[];
  output: string;
  available: boolean;
  missingIntegrations: string[];
}

export type PowerResponseType = "text" | "report" | "code" | "pr" | "image" | "table" | "links" | "mixed";

export interface PowerResponseText {
  type: "text";
  content: string;
}

export interface PowerResponseReport {
  type: "report";
  title: string;
  summary: string;
  sections: Array<{ heading: string; content: string; severity?: "info" | "warning" | "critical" }>;
  score?: number;
}

export interface PowerResponseCode {
  type: "code";
  files: Array<{ path: string; language: string; content: string; diff?: string }>;
}

export interface PowerResponsePR {
  type: "pr";
  prs: Array<{ repo: string; number: number; title: string; url: string; status: "open" | "merged" | "closed" }>;
}

export interface PowerResponseImage {
  type: "image";
  images: Array<{ url: string; alt?: string; caption?: string }>;
}

export interface PowerResponseTable {
  type: "table";
  title?: string;
  columns: string[];
  rows: string[][];
}

export interface PowerResponseLinks {
  type: "links";
  links: Array<{ url: string; label: string; description?: string }>;
}

export interface PowerResponseMixed {
  type: "mixed";
  items: PowerResponse[];
}

export type PowerResponse =
  | PowerResponseText
  | PowerResponseReport
  | PowerResponseCode
  | PowerResponsePR
  | PowerResponseImage
  | PowerResponseTable
  | PowerResponseLinks
  | PowerResponseMixed;
