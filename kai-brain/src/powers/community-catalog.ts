export interface CommunityPower {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  dependsOn: string[];
  steps: string[];
  prompt: string;
}

export const COMMUNITY_POWERS: CommunityPower[] = [
  {
    id: "code-review",
    name: "Code Review",
    description: "Review open PRs for bugs, style issues, and improvement opportunities.",
    icon: "🔍",
    category: "quality",
    dependsOn: ["github"],
    steps: [
      "List open pull requests",
      "Analyze diff for each PR",
      "Check for bugs, security issues, and style violations",
      "Post review comments with suggestions",
    ],
    prompt: `Review all open pull requests on the repository.

For each PR:
1. Read the diff carefully
2. Look for bugs, security issues, performance problems, and style violations
3. Check that the PR description matches the changes
4. Post a review with inline comments for any issues found
5. Approve if the code looks good, or request changes if needed

Be constructive and specific in feedback. Focus on real issues, not nitpicks.`,
  },
  {
    id: "sprint-planner",
    name: "Sprint Planner",
    description: "Analyze backlog, prioritize issues, and draft a sprint plan.",
    icon: "📋",
    category: "ops",
    dependsOn: ["linear"],
    steps: [
      "Fetch backlog and current sprint status",
      "Analyze priorities and dependencies",
      "Estimate effort for top items",
      "Draft sprint plan with assignments",
    ],
    prompt: `Analyze the project backlog and create a sprint plan.

1. List all unassigned and backlog issues
2. Group by priority and theme
3. Identify blockers and dependencies between issues
4. Suggest which issues to include in the next sprint based on team capacity
5. Draft a summary with recommended assignments

Output a clear sprint plan document.`,
  },
  {
    id: "api-docs-generator",
    name: "API Docs Generator",
    description: "Scan the codebase and generate comprehensive API documentation.",
    icon: "📖",
    category: "quality",
    dependsOn: [],
    steps: [
      "Discover API routes and endpoints",
      "Extract request/response schemas",
      "Generate markdown documentation",
      "Include usage examples",
    ],
    prompt: `Scan the codebase for API routes and endpoints.

1. Find all HTTP route definitions (Express, Fastify, Next.js API routes, etc.)
2. For each endpoint, extract: method, path, request params/body, response shape
3. Look for authentication requirements
4. Generate comprehensive markdown documentation with:
   - Endpoint summary table
   - Detailed per-endpoint docs with request/response examples
   - Authentication requirements
   - Error codes

Write the documentation to docs/API.md.`,
  },
  {
    id: "dependency-audit",
    name: "Dependency Audit",
    description: "Check all dependencies for outdated versions, vulnerabilities, and license issues.",
    icon: "📦",
    category: "security",
    dependsOn: [],
    steps: [
      "Parse dependency files",
      "Check for outdated packages",
      "Scan for known vulnerabilities",
      "Review license compatibility",
      "Generate audit report",
    ],
    prompt: `Audit all project dependencies for security and freshness.

1. Read package.json, requirements.txt, go.mod, or equivalent
2. Run the appropriate audit command (npm audit, pip audit, etc.)
3. Check for outdated major versions using web search
4. Review licenses for compatibility issues
5. Create a prioritized report:
   - Critical vulnerabilities to fix immediately
   - Major version upgrades available
   - License concerns
   - Recommendations

Output a clear report with actionable next steps.`,
  },
  {
    id: "incident-responder",
    name: "Incident Responder",
    description: "Investigate production issues, gather logs, and coordinate response in Slack.",
    icon: "🚨",
    category: "ops",
    dependsOn: ["slack"],
    steps: [
      "Gather context from recent alerts",
      "Check logs and metrics",
      "Identify root cause",
      "Post status update to Slack",
      "Suggest remediation steps",
    ],
    prompt: `Help investigate and respond to a production incident.

1. Ask for the incident details or check recent Slack messages for alerts
2. Gather relevant logs using exec commands
3. Check application health and error rates
4. Identify the likely root cause
5. Post a structured status update to the incidents channel:
   - Impact summary
   - Root cause (known/investigating)
   - Current status
   - Next steps
6. Suggest specific remediation actions

Stay calm and systematic. Prioritize restoring service over root cause analysis.`,
  },
  {
    id: "performance-profiler",
    name: "Performance Profiler",
    description: "Analyze the codebase for performance bottlenecks and optimization opportunities.",
    icon: "⚡",
    category: "quality",
    dependsOn: [],
    steps: [
      "Scan for common performance anti-patterns",
      "Identify N+1 queries and heavy computations",
      "Check bundle size and lazy loading",
      "Profile database queries",
      "Generate optimization report",
    ],
    prompt: `Analyze the codebase for performance issues and optimization opportunities.

1. Scan for common anti-patterns:
   - N+1 database queries
   - Missing indexes (check query patterns vs schema)
   - Unbounded data fetching (no pagination/limits)
   - Synchronous operations that should be async
   - Memory leaks (event listeners, intervals not cleaned up)
2. Check frontend bundle:
   - Large dependencies that could be lazy loaded
   - Missing code splitting opportunities
   - Unoptimized images or assets
3. Review database queries for optimization
4. Generate a prioritized report with specific fixes for each issue

Focus on high-impact, easy-to-fix improvements first.`,
  },
  {
    id: "test-generator",
    name: "Test Generator",
    description: "Analyze untested code paths and generate comprehensive test suites.",
    icon: "🧪",
    category: "quality",
    dependsOn: [],
    steps: [
      "Identify files with low or no test coverage",
      "Analyze critical code paths",
      "Generate unit tests for core logic",
      "Generate integration tests for API endpoints",
      "Verify tests pass",
    ],
    prompt: `Generate tests for untested parts of the codebase.

1. Find source files that have no corresponding test file
2. Prioritize: API endpoints, business logic, utility functions
3. For each untested module, generate tests covering:
   - Happy path
   - Edge cases
   - Error handling
4. Use the project's existing test framework and patterns
5. Run the tests to verify they pass
6. Fix any failures

Match the project's testing style and conventions.`,
  },
  {
    id: "design-system-audit",
    name: "Design System Audit",
    description: "Audit UI components for consistency, accessibility, and design token usage.",
    icon: "🎨",
    category: "quality",
    dependsOn: ["figma"],
    steps: [
      "Scan component library",
      "Check design token consistency",
      "Run accessibility checks",
      "Compare with Figma designs",
      "Generate audit report",
    ],
    prompt: `Audit the UI codebase for design system consistency.

1. Scan all React/Vue/Svelte components
2. Check for:
   - Hardcoded colors, fonts, spacing (should use tokens)
   - Inconsistent component patterns
   - Missing aria labels and roles
   - Color contrast issues
3. If Figma access is available, compare implemented components with designs
4. Generate a report:
   - Components not using design tokens
   - Accessibility violations
   - Inconsistencies with design specs
   - Recommendations for standardization

Focus on patterns that affect many components, not one-off issues.`,
  },
  {
    id: "db-migration-planner",
    name: "DB Migration Planner",
    description: "Analyze schema changes, generate safe migrations, and plan rollback strategies.",
    icon: "🗄️",
    category: "ops",
    dependsOn: ["postgres"],
    steps: [
      "Compare current schema with desired state",
      "Generate migration SQL",
      "Check for data loss risks",
      "Create rollback plan",
      "Test migration on sample data",
    ],
    prompt: `Help plan and create a safe database migration.

1. Read the current schema and identify what needs to change
2. Generate migration SQL that:
   - Uses IF NOT EXISTS / IF EXISTS guards
   - Handles column additions with sensible defaults
   - Avoids locking large tables unnecessarily
   - Preserves existing data
3. For each change, assess:
   - Risk of data loss
   - Expected downtime/locking
   - Backward compatibility with current code
4. Generate a rollback migration
5. Test the migration against the current database

Output the migration file and a summary of risks and rollback steps.`,
  },
  {
    id: "competitive-analysis",
    name: "Competitive Analysis",
    description: "Research competitors, analyze features, and generate a comparison report.",
    icon: "🏆",
    category: "analysis",
    dependsOn: [],
    steps: [
      "Identify key competitors",
      "Research features and pricing",
      "Analyze strengths and weaknesses",
      "Generate comparison matrix",
      "Suggest strategic opportunities",
    ],
    prompt: `Conduct a competitive analysis for the product.

1. Ask about or infer the product category and key competitors
2. For each competitor, research:
   - Core features and differentiators
   - Pricing model
   - Target audience
   - Recent launches or changes
3. Create a feature comparison matrix
4. Analyze:
   - Where we're ahead vs behind
   - Unserved market gaps
   - Pricing positioning
5. Suggest strategic opportunities based on the analysis

Use web search for up-to-date information. Be specific and data-driven.`,
  },
];
