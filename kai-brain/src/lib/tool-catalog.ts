export interface TaskDef {
  suffix: string;
  label: string;
  description: string;
}

export interface ToolCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  credentialKey: string;
  tasks: TaskDef[];
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // ── General ──────────────────────────────────────────────────
  {
    id: "slack", name: "Slack", description: "Team messaging and notifications",
    category: "general", credentialKey: "slack_bot_token",
    tasks: [
      { suffix: "messaging", label: "Messaging", description: "Send and read messages in channels and threads" },
      { suffix: "channels", label: "Channel Ops", description: "Create, archive, and manage channels" },
      { suffix: "notifications", label: "Notifications", description: "Send alerts and scheduled reminders" },
    ],
  },
  {
    id: "google", name: "Google", description: "Workspace, Drive, Calendar",
    category: "general", credentialKey: "google_api_key",
    tasks: [
      { suffix: "docs", label: "Document Search", description: "Search and read Google Docs" },
      { suffix: "calendar", label: "Calendar", description: "View and create calendar events" },
      { suffix: "drive", label: "Drive Access", description: "Browse and manage files" },
    ],
  },
  {
    id: "openai", name: "OpenAI", description: "GPT models and embeddings",
    category: "general", credentialKey: "openai_api_key",
    tasks: [
      { suffix: "generation", label: "Text Generation", description: "Generate text with GPT models" },
      { suffix: "embeddings", label: "Embeddings", description: "Create vector embeddings" },
      { suffix: "vision", label: "Vision", description: "Analyze images with GPT-4V" },
    ],
  },
  {
    id: "anthropic", name: "Anthropic", description: "Claude models",
    category: "general", credentialKey: "anthropic_api_key",
    tasks: [
      { suffix: "generation", label: "Text Generation", description: "Generate text with Claude" },
      { suffix: "analysis", label: "Analysis", description: "Deep analysis and reasoning" },
      { suffix: "code", label: "Code Review", description: "Review and improve code" },
    ],
  },

  // ── Engineering ──────────────────────────────────────────────
  {
    id: "github", name: "GitHub", description: "Repos, PRs, issues, actions",
    category: "engineering", credentialKey: "github_token",
    tasks: [
      { suffix: "pr-review", label: "PR Review", description: "Review and comment on pull requests" },
      { suffix: "issues", label: "Issue Management", description: "Create, triage, and close issues" },
      { suffix: "code-search", label: "Code Search", description: "Search across repositories" },
      { suffix: "actions", label: "Actions & CI", description: "Monitor and trigger workflows" },
    ],
  },
  {
    id: "gitlab", name: "GitLab", description: "Repos, merge requests, CI/CD",
    category: "engineering", credentialKey: "gitlab_token",
    tasks: [
      { suffix: "mrs", label: "Merge Requests", description: "Review and manage merge requests" },
      { suffix: "issues", label: "Issue Tracking", description: "Create and manage issues" },
      { suffix: "pipelines", label: "Pipelines", description: "Monitor CI/CD pipelines" },
    ],
  },
  {
    id: "bitbucket", name: "Bitbucket", description: "Repos and pipelines",
    category: "engineering", credentialKey: "bitbucket_token",
    tasks: [
      { suffix: "prs", label: "Pull Requests", description: "Review and manage PRs" },
      { suffix: "repos", label: "Repositories", description: "Manage repository settings" },
      { suffix: "pipelines", label: "Pipelines", description: "Monitor build pipelines" },
    ],
  },
  {
    id: "vercel", name: "Vercel", description: "Deployment and hosting",
    category: "engineering", credentialKey: "vercel_token",
    tasks: [
      { suffix: "deployments", label: "Deployments", description: "Deploy and monitor apps" },
      { suffix: "preview", label: "Preview URLs", description: "Manage preview deployments" },
      { suffix: "domains", label: "Domains", description: "Configure custom domains" },
    ],
  },
  {
    id: "aws", name: "AWS", description: "Cloud infrastructure",
    category: "engineering", credentialKey: "aws_credentials",
    tasks: [
      { suffix: "infra", label: "Infrastructure", description: "Manage cloud resources" },
      { suffix: "s3", label: "S3 Storage", description: "Manage files and buckets" },
      { suffix: "lambda", label: "Lambda", description: "Deploy and invoke functions" },
    ],
  },
  {
    id: "supabase", name: "Supabase", description: "Database, auth, storage",
    category: "engineering", credentialKey: "supabase_key",
    tasks: [
      { suffix: "queries", label: "Database", description: "Run SQL queries" },
      { suffix: "auth", label: "Auth", description: "Manage users and sessions" },
      { suffix: "storage", label: "Storage", description: "Upload and manage files" },
    ],
  },
  {
    id: "postgres", name: "PostgreSQL", description: "Database access",
    category: "engineering", credentialKey: "postgres_external_url",
    tasks: [
      { suffix: "queries", label: "Queries", description: "Execute SQL queries" },
      { suffix: "schema", label: "Schema", description: "Inspect table structures" },
      { suffix: "export", label: "Data Export", description: "Export query results" },
    ],
  },
  {
    id: "redis", name: "Redis", description: "Cache and key-value store",
    category: "engineering", credentialKey: "redis_url",
    tasks: [
      { suffix: "cache", label: "Cache Ops", description: "Get, set, and manage keys" },
      { suffix: "monitoring", label: "Monitoring", description: "Check memory and stats" },
    ],
  },
  {
    id: "mongodb", name: "MongoDB", description: "Document database",
    category: "engineering", credentialKey: "mongodb_url",
    tasks: [
      { suffix: "queries", label: "Queries", description: "Find and aggregate documents" },
      { suffix: "collections", label: "Collections", description: "Manage collections and indexes" },
    ],
  },
  {
    id: "docker", name: "Docker", description: "Container management",
    category: "engineering", credentialKey: "docker_config",
    tasks: [
      { suffix: "containers", label: "Containers", description: "Start, stop, and manage containers" },
      { suffix: "images", label: "Images", description: "Build and manage images" },
      { suffix: "logs", label: "Logs", description: "View container logs" },
    ],
  },

  {
    id: "netlify", name: "Netlify", description: "Deployment and hosting",
    category: "engineering", credentialKey: "netlify_token",
    tasks: [
      { suffix: "deploys", label: "Deploys", description: "Trigger and monitor deploys" },
      { suffix: "sites", label: "Sites", description: "Manage sites and settings" },
    ],
  },
  {
    id: "cloudflare", name: "Cloudflare", description: "CDN, DNS, and edge workers",
    category: "engineering", credentialKey: "cloudflare_api_key",
    tasks: [
      { suffix: "dns", label: "DNS", description: "Manage DNS records" },
      { suffix: "workers", label: "Workers", description: "Deploy edge functions" },
    ],
  },
  {
    id: "sentry", name: "Sentry", description: "Error tracking and monitoring",
    category: "engineering", credentialKey: "sentry_auth_token",
    tasks: [
      { suffix: "issues", label: "Issues", description: "View and resolve errors" },
      { suffix: "alerts", label: "Alerts", description: "Configure alert rules" },
    ],
  },
  {
    id: "datadog", name: "Datadog", description: "Infrastructure monitoring and APM",
    category: "engineering", credentialKey: "datadog_api_key",
    tasks: [
      { suffix: "metrics", label: "Metrics", description: "Query and graph metrics" },
      { suffix: "monitors", label: "Monitors", description: "Manage alerts and monitors" },
      { suffix: "logs", label: "Logs", description: "Search and analyze logs" },
    ],
  },
  {
    id: "mysql", name: "MySQL", description: "Relational database",
    category: "engineering", credentialKey: "mysql_url",
    tasks: [
      { suffix: "queries", label: "Queries", description: "Execute SQL queries" },
      { suffix: "schema", label: "Schema", description: "Inspect table structures" },
    ],
  },
  {
    id: "firebase", name: "Firebase", description: "App platform by Google",
    category: "engineering", credentialKey: "firebase_service_account",
    tasks: [
      { suffix: "firestore", label: "Firestore", description: "Query and manage documents" },
      { suffix: "auth", label: "Auth", description: "Manage users and sessions" },
      { suffix: "hosting", label: "Hosting", description: "Deploy web apps" },
    ],
  },
  {
    id: "kubernetes", name: "Kubernetes", description: "Container orchestration",
    category: "engineering", credentialKey: "kubeconfig",
    tasks: [
      { suffix: "pods", label: "Pods", description: "Manage pods and deployments" },
      { suffix: "logs", label: "Logs", description: "View pod and container logs" },
      { suffix: "services", label: "Services", description: "Manage services and ingress" },
    ],
  },
  {
    id: "terraform", name: "Terraform", description: "Infrastructure as code",
    category: "engineering", credentialKey: "terraform_cloud_token",
    tasks: [
      { suffix: "plan", label: "Plan", description: "Preview infrastructure changes" },
      { suffix: "state", label: "State", description: "Inspect current state" },
    ],
  },
  {
    id: "pagerduty", name: "PagerDuty", description: "Incident management",
    category: "engineering", credentialKey: "pagerduty_api_key",
    tasks: [
      { suffix: "incidents", label: "Incidents", description: "View and manage incidents" },
      { suffix: "oncall", label: "On-Call", description: "Check on-call schedules" },
    ],
  },
  {
    id: "grafana", name: "Grafana", description: "Dashboards and observability",
    category: "engineering", credentialKey: "grafana_api_key",
    tasks: [
      { suffix: "dashboards", label: "Dashboards", description: "View and manage dashboards" },
      { suffix: "alerts", label: "Alerts", description: "Configure alert rules" },
    ],
  },
  {
    id: "heroku", name: "Heroku", description: "App platform and hosting",
    category: "engineering", credentialKey: "heroku_api_key",
    tasks: [
      { suffix: "apps", label: "Apps", description: "Manage and deploy apps" },
      { suffix: "logs", label: "Logs", description: "View app logs" },
    ],
  },
  {
    id: "elasticsearch", name: "Elasticsearch", description: "Search and analytics engine",
    category: "engineering", credentialKey: "elasticsearch_url",
    tasks: [
      { suffix: "search", label: "Search", description: "Query and search indexes" },
      { suffix: "indexes", label: "Indexes", description: "Manage indexes and mappings" },
    ],
  },
  {
    id: "neon", name: "Neon", description: "Serverless Postgres",
    category: "engineering", credentialKey: "neon_api_key",
    tasks: [
      { suffix: "queries", label: "Queries", description: "Execute SQL queries" },
      { suffix: "branches", label: "Branches", description: "Manage database branches" },
    ],
  },
  {
    id: "planetscale", name: "PlanetScale", description: "Serverless MySQL",
    category: "engineering", credentialKey: "planetscale_token",
    tasks: [
      { suffix: "queries", label: "Queries", description: "Execute SQL queries" },
      { suffix: "branches", label: "Branches", description: "Manage database branches" },
    ],
  },

  // ── Design ───────────────────────────────────────────────────
  {
    id: "figma", name: "Figma", description: "Design files and prototypes",
    category: "design", credentialKey: "figma_token",
    tasks: [
      { suffix: "review", label: "Design Review", description: "Review design files and comments" },
      { suffix: "components", label: "Components", description: "Browse component library" },
      { suffix: "export", label: "Export Assets", description: "Export images and icons" },
    ],
  },
  {
    id: "storybook", name: "Storybook", description: "UI component explorer",
    category: "design", credentialKey: "storybook_url",
    tasks: [
      { suffix: "components", label: "Components", description: "Browse and test components" },
      { suffix: "visual", label: "Visual Tests", description: "Check for visual regressions" },
    ],
  },
  {
    id: "framer", name: "Framer", description: "Interactive prototypes and sites",
    category: "design", credentialKey: "framer_token",
    tasks: [
      { suffix: "projects", label: "Projects", description: "Browse design projects" },
      { suffix: "publish", label: "Publish", description: "Publish and manage sites" },
    ],
  },

  // ── Product ──────────────────────────────────────────────────
  {
    id: "linear", name: "Linear", description: "Issue tracking and projects",
    category: "product", credentialKey: "linear_api_key",
    tasks: [
      { suffix: "issues", label: "Issues", description: "Create and manage issues" },
      { suffix: "cycles", label: "Cycles", description: "Plan and track cycles" },
      { suffix: "roadmap", label: "Roadmap", description: "View project roadmap" },
    ],
  },
  {
    id: "jira", name: "Jira", description: "Issue tracking and boards",
    category: "product", credentialKey: "jira_api_key",
    tasks: [
      { suffix: "issues", label: "Issues", description: "Create and manage issues" },
      { suffix: "sprints", label: "Sprints", description: "Plan and track sprints" },
      { suffix: "boards", label: "Boards", description: "View kanban and scrum boards" },
    ],
  },
  {
    id: "notion", name: "Notion", description: "Docs, wikis, databases",
    category: "product", credentialKey: "notion_api_key",
    tasks: [
      { suffix: "pages", label: "Pages", description: "Search and create pages" },
      { suffix: "databases", label: "Databases", description: "Query and update databases" },
      { suffix: "wiki", label: "Wiki", description: "Browse team knowledge base" },
    ],
  },
  {
    id: "confluence", name: "Confluence", description: "Team documentation",
    category: "product", credentialKey: "confluence_api_key",
    tasks: [
      { suffix: "pages", label: "Pages", description: "Search and create pages" },
      { suffix: "spaces", label: "Spaces", description: "Browse team spaces" },
    ],
  },
  {
    id: "stripe", name: "Stripe", description: "Payments and billing",
    category: "product", credentialKey: "stripe_api_key",
    tasks: [
      { suffix: "payments", label: "Payments", description: "View payment activity" },
      { suffix: "subscriptions", label: "Subscriptions", description: "Manage subscriptions" },
      { suffix: "invoices", label: "Invoices", description: "View and send invoices" },
    ],
  },
  {
    id: "twilio", name: "Twilio", description: "SMS and messaging",
    category: "product", credentialKey: "twilio_api_key",
    tasks: [
      { suffix: "sms", label: "SMS", description: "Send text messages" },
      { suffix: "calls", label: "Voice", description: "Make and manage calls" },
      { suffix: "history", label: "History", description: "View message history" },
    ],
  },
  {
    id: "sendgrid", name: "SendGrid", description: "Email delivery",
    category: "product", credentialKey: "sendgrid_api_key",
    tasks: [
      { suffix: "email", label: "Send Email", description: "Send transactional emails" },
      { suffix: "templates", label: "Templates", description: "Manage email templates" },
      { suffix: "stats", label: "Analytics", description: "View delivery statistics" },
    ],
  },
  {
    id: "asana", name: "Asana", description: "Project and task management",
    category: "product", credentialKey: "asana_token",
    tasks: [
      { suffix: "tasks", label: "Tasks", description: "Create and manage tasks" },
      { suffix: "projects", label: "Projects", description: "View and manage projects" },
    ],
  },
  {
    id: "trello", name: "Trello", description: "Kanban boards and cards",
    category: "product", credentialKey: "trello_api_key",
    tasks: [
      { suffix: "cards", label: "Cards", description: "Create and manage cards" },
      { suffix: "boards", label: "Boards", description: "View and manage boards" },
    ],
  },
  {
    id: "clickup", name: "ClickUp", description: "All-in-one project management",
    category: "product", credentialKey: "clickup_api_key",
    tasks: [
      { suffix: "tasks", label: "Tasks", description: "Create and manage tasks" },
      { suffix: "spaces", label: "Spaces", description: "Manage spaces and lists" },
    ],
  },
  {
    id: "hubspot", name: "HubSpot", description: "CRM, marketing, and sales",
    category: "product", credentialKey: "hubspot_api_key",
    tasks: [
      { suffix: "contacts", label: "Contacts", description: "Manage contacts and companies" },
      { suffix: "deals", label: "Deals", description: "Track deals and pipeline" },
      { suffix: "email", label: "Email", description: "Send and track emails" },
    ],
  },
  {
    id: "intercom", name: "Intercom", description: "Customer messaging platform",
    category: "product", credentialKey: "intercom_token",
    tasks: [
      { suffix: "conversations", label: "Conversations", description: "View and reply to conversations" },
      { suffix: "contacts", label: "Contacts", description: "Manage user profiles" },
    ],
  },
  {
    id: "zendesk", name: "Zendesk", description: "Customer support and ticketing",
    category: "product", credentialKey: "zendesk_api_key",
    tasks: [
      { suffix: "tickets", label: "Tickets", description: "Create and manage tickets" },
      { suffix: "customers", label: "Customers", description: "View customer profiles" },
    ],
  },
  {
    id: "amplitude", name: "Amplitude", description: "Product analytics",
    category: "product", credentialKey: "amplitude_api_key",
    tasks: [
      { suffix: "events", label: "Events", description: "Query event data" },
      { suffix: "charts", label: "Charts", description: "View analytics charts" },
    ],
  },
  {
    id: "mixpanel", name: "Mixpanel", description: "Event analytics and funnels",
    category: "product", credentialKey: "mixpanel_token",
    tasks: [
      { suffix: "events", label: "Events", description: "Query event data" },
      { suffix: "funnels", label: "Funnels", description: "Analyze conversion funnels" },
    ],
  },
  {
    id: "posthog", name: "PostHog", description: "Open-source product analytics",
    category: "product", credentialKey: "posthog_api_key",
    tasks: [
      { suffix: "events", label: "Events", description: "Query event data" },
      { suffix: "flags", label: "Feature Flags", description: "Manage feature flags" },
    ],
  },
  {
    id: "airtable", name: "Airtable", description: "Spreadsheet-database hybrid",
    category: "product", credentialKey: "airtable_api_key",
    tasks: [
      { suffix: "records", label: "Records", description: "Query and manage records" },
      { suffix: "bases", label: "Bases", description: "Browse bases and tables" },
    ],
  },
  {
    id: "salesforce", name: "Salesforce", description: "Enterprise CRM",
    category: "product", credentialKey: "salesforce_token",
    tasks: [
      { suffix: "accounts", label: "Accounts", description: "Manage accounts and contacts" },
      { suffix: "opportunities", label: "Opportunities", description: "Track deals and pipeline" },
      { suffix: "reports", label: "Reports", description: "View and run reports" },
    ],
  },
  {
    id: "shopify", name: "Shopify", description: "E-commerce platform",
    category: "product", credentialKey: "shopify_access_token",
    tasks: [
      { suffix: "orders", label: "Orders", description: "View and manage orders" },
      { suffix: "products", label: "Products", description: "Manage product catalog" },
      { suffix: "analytics", label: "Analytics", description: "View sales analytics" },
    ],
  },
  {
    id: "mailchimp", name: "Mailchimp", description: "Email marketing campaigns",
    category: "product", credentialKey: "mailchimp_api_key",
    tasks: [
      { suffix: "campaigns", label: "Campaigns", description: "Create and send campaigns" },
      { suffix: "lists", label: "Audiences", description: "Manage subscriber lists" },
    ],
  },
];

const CATALOG_MAP = new Map(TOOL_CATALOG.map((t) => [t.id, t]));

export function getCatalogEntry(id: string): ToolCatalogEntry | undefined {
  return CATALOG_MAP.get(id);
}
