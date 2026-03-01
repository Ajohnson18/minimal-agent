export interface ToolCatalogItem {
  id: string;
  name: string;
  description: string;
  category: "general" | "engineering" | "design" | "product";
}

export const TOOL_CATALOG: ToolCatalogItem[] = [
  // General
  { id: "slack", name: "Slack", description: "Team messaging and notifications", category: "general" },
  { id: "google", name: "Google", description: "Workspace, Drive, Calendar", category: "general" },
  { id: "openai", name: "OpenAI", description: "GPT models and embeddings", category: "general" },
  { id: "anthropic", name: "Anthropic", description: "Claude models", category: "general" },

  // Engineering
  { id: "github", name: "GitHub", description: "Repos, PRs, issues, actions", category: "engineering" },
  { id: "gitlab", name: "GitLab", description: "Repos, merge requests, CI/CD", category: "engineering" },
  { id: "bitbucket", name: "Bitbucket", description: "Repos and pipelines", category: "engineering" },
  { id: "vercel", name: "Vercel", description: "Deployment and hosting", category: "engineering" },
  { id: "netlify", name: "Netlify", description: "Deployment and hosting", category: "engineering" },
  { id: "cloudflare", name: "Cloudflare", description: "CDN, DNS, and edge workers", category: "engineering" },
  { id: "aws", name: "AWS", description: "Cloud infrastructure", category: "engineering" },
  { id: "supabase", name: "Supabase", description: "Database, auth, storage", category: "engineering" },
  { id: "postgres", name: "PostgreSQL", description: "Database access", category: "engineering" },
  { id: "mysql", name: "MySQL", description: "Relational database", category: "engineering" },
  { id: "redis", name: "Redis", description: "Cache and key-value store", category: "engineering" },
  { id: "mongodb", name: "MongoDB", description: "Document database", category: "engineering" },
  { id: "firebase", name: "Firebase", description: "App platform by Google", category: "engineering" },
  { id: "elasticsearch", name: "Elasticsearch", description: "Search and analytics engine", category: "engineering" },
  { id: "neon", name: "Neon", description: "Serverless Postgres", category: "engineering" },
  { id: "planetscale", name: "PlanetScale", description: "Serverless MySQL", category: "engineering" },
  { id: "docker", name: "Docker", description: "Container management", category: "engineering" },
  { id: "kubernetes", name: "Kubernetes", description: "Container orchestration", category: "engineering" },
  { id: "terraform", name: "Terraform", description: "Infrastructure as code", category: "engineering" },
  { id: "sentry", name: "Sentry", description: "Error tracking and monitoring", category: "engineering" },
  { id: "datadog", name: "Datadog", description: "Infrastructure monitoring and APM", category: "engineering" },
  { id: "grafana", name: "Grafana", description: "Dashboards and observability", category: "engineering" },
  { id: "pagerduty", name: "PagerDuty", description: "Incident management", category: "engineering" },
  { id: "heroku", name: "Heroku", description: "App platform and hosting", category: "engineering" },

  // Design
  { id: "figma", name: "Figma", description: "Design files and prototypes", category: "design" },
  { id: "storybook", name: "Storybook", description: "UI component explorer", category: "design" },
  { id: "framer", name: "Framer", description: "Interactive prototypes and sites", category: "design" },

  // Product
  { id: "linear", name: "Linear", description: "Issue tracking and projects", category: "product" },
  { id: "jira", name: "Jira", description: "Issue tracking and boards", category: "product" },
  { id: "notion", name: "Notion", description: "Docs, wikis, databases", category: "product" },
  { id: "confluence", name: "Confluence", description: "Team documentation", category: "product" },
  { id: "asana", name: "Asana", description: "Project and task management", category: "product" },
  { id: "trello", name: "Trello", description: "Kanban boards and cards", category: "product" },
  { id: "clickup", name: "ClickUp", description: "All-in-one project management", category: "product" },
  { id: "stripe", name: "Stripe", description: "Payments and billing", category: "product" },
  { id: "shopify", name: "Shopify", description: "E-commerce platform", category: "product" },
  { id: "hubspot", name: "HubSpot", description: "CRM, marketing, and sales", category: "product" },
  { id: "salesforce", name: "Salesforce", description: "Enterprise CRM", category: "product" },
  { id: "intercom", name: "Intercom", description: "Customer messaging platform", category: "product" },
  { id: "zendesk", name: "Zendesk", description: "Customer support and ticketing", category: "product" },
  { id: "twilio", name: "Twilio", description: "SMS and messaging", category: "product" },
  { id: "sendgrid", name: "SendGrid", description: "Email delivery", category: "product" },
  { id: "mailchimp", name: "Mailchimp", description: "Email marketing campaigns", category: "product" },
  { id: "amplitude", name: "Amplitude", description: "Product analytics", category: "product" },
  { id: "mixpanel", name: "Mixpanel", description: "Event analytics and funnels", category: "product" },
  { id: "posthog", name: "PostHog", description: "Open-source product analytics", category: "product" },
  { id: "airtable", name: "Airtable", description: "Spreadsheet-database hybrid", category: "product" },
];

export const TOOL_CATEGORIES = [
  { id: "general" as const, label: "General", color: "#3b82f6" },
  { id: "engineering" as const, label: "Engineering", color: "#f97316" },
  { id: "design" as const, label: "Design", color: "#a855f7" },
  { id: "product" as const, label: "Product", color: "#06b6d4" },
];
