import { useState } from "react";
import { apiPut } from "../../api/client";

interface Props {
  credentialKey: string;
  label?: string;
  placeholder?: string;
  helpUrl?: string;
  onSaved: (key: string) => void;
}

const ENV_VAR_HELP: Record<string, { label: string; placeholder: string; helpUrl?: string }> = {
  // General
  slack_bot_token: { label: "Slack Bot Token", placeholder: "xoxb-xxxxxxxxxxxx", helpUrl: "https://api.slack.com/apps" },
  google_api_key: { label: "Google API Key", placeholder: "AIzaSy...", helpUrl: "https://console.cloud.google.com/apis/credentials" },
  openai_api_key: { label: "OpenAI API Key", placeholder: "sk-xxxxxxxxxxxxxxxx", helpUrl: "https://platform.openai.com/api-keys" },
  anthropic_api_key: { label: "Anthropic API Key", placeholder: "sk-ant-xxxxxxxxxxxxxxxx", helpUrl: "https://console.anthropic.com/settings/keys" },
  // Engineering
  github_token: { label: "GitHub Personal Access Token", placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx", helpUrl: "https://github.com/settings/tokens" },
  gitlab_token: { label: "GitLab Personal Access Token", placeholder: "glpat-xxxxxxxxxxxx", helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens" },
  bitbucket_token: { label: "Bitbucket App Password", placeholder: "xxxxxxxxxxxx", helpUrl: "https://bitbucket.org/account/settings/app-passwords/" },
  vercel_token: { label: "Vercel Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://vercel.com/account/tokens" },
  aws_credentials: { label: "AWS Credentials", placeholder: "AKIAIOSFODNN7EXAMPLE", helpUrl: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  supabase_key: { label: "Supabase Service Key", placeholder: "eyJhbGciOi...", helpUrl: "https://supabase.com/dashboard/project/_/settings/api" },
  postgres_external_url: { label: "PostgreSQL Connection URL", placeholder: "postgresql://user:pass@host:5432/db" },
  redis_url: { label: "Redis URL", placeholder: "redis://user:pass@host:6379" },
  mongodb_url: { label: "MongoDB URL", placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/db" },
  docker_config: { label: "Docker Config", placeholder: "xxxxxxxxxxxx" },
  netlify_token: { label: "Netlify Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://app.netlify.com/user/applications#personal-access-tokens" },
  cloudflare_api_key: { label: "Cloudflare API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://dash.cloudflare.com/profile/api-tokens" },
  sentry_auth_token: { label: "Sentry Auth Token", placeholder: "sntrys_xxxxxxxxxxxx", helpUrl: "https://sentry.io/settings/account/api/auth-tokens/" },
  datadog_api_key: { label: "Datadog API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://app.datadoghq.com/organization-settings/api-keys" },
  mysql_url: { label: "MySQL Connection URL", placeholder: "mysql://user:pass@host:3306/db" },
  firebase_service_account: { label: "Firebase Service Account", placeholder: '{"type":"service_account",...}', helpUrl: "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk" },
  kubeconfig: { label: "Kubernetes Config", placeholder: "xxxxxxxxxxxx" },
  terraform_cloud_token: { label: "Terraform Cloud Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://app.terraform.io/app/settings/tokens" },
  pagerduty_api_key: { label: "PagerDuty API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://support.pagerduty.com/main/docs/api-access-keys" },
  grafana_api_key: { label: "Grafana API Key", placeholder: "glsa_xxxxxxxxxxxx", helpUrl: "https://grafana.com/docs/grafana/latest/administration/api-keys/" },
  heroku_api_key: { label: "Heroku API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://dashboard.heroku.com/account" },
  elasticsearch_url: { label: "Elasticsearch URL", placeholder: "https://user:pass@host:9200" },
  neon_api_key: { label: "Neon API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://console.neon.tech/app/settings/api-keys" },
  planetscale_token: { label: "PlanetScale Token", placeholder: "pscale_tkn_xxxxxxxxxxxx", helpUrl: "https://app.planetscale.com/settings/service-tokens" },
  // Design
  figma_token: { label: "Figma Personal Access Token", placeholder: "figd_xxxxxxxxxxxxxxxx", helpUrl: "https://www.figma.com/developers/api#access-tokens" },
  storybook_url: { label: "Storybook URL", placeholder: "https://your-storybook.example.com" },
  framer_token: { label: "Framer Token", placeholder: "xxxxxxxxxxxx" },
  // Product
  linear_api_key: { label: "Linear API Key", placeholder: "lin_api_xxxxxxxxxxxxxxxx", helpUrl: "https://linear.app/settings/api" },
  jira_api_key: { label: "Jira API Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens" },
  notion_api_key: { label: "Notion Integration Token", placeholder: "ntn_xxxxxxxxxxxxxxxx", helpUrl: "https://www.notion.so/my-integrations" },
  confluence_api_key: { label: "Confluence API Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens" },
  stripe_api_key: { label: "Stripe Secret Key", placeholder: "sk_live_xxxxxxxxxxxx", helpUrl: "https://dashboard.stripe.com/apikeys" },
  twilio_api_key: { label: "Twilio API Key", placeholder: "SKxxxxxxxxxxxx", helpUrl: "https://www.twilio.com/console/project/api-keys" },
  sendgrid_api_key: { label: "SendGrid API Key", placeholder: "SG.xxxxxxxxxxxx", helpUrl: "https://app.sendgrid.com/settings/api_keys" },
  asana_token: { label: "Asana Personal Access Token", placeholder: "1/xxxxxxxxxxxx", helpUrl: "https://app.asana.com/0/developer-console" },
  trello_api_key: { label: "Trello API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://trello.com/power-ups/admin" },
  clickup_api_key: { label: "ClickUp API Key", placeholder: "pk_xxxxxxxxxxxx", helpUrl: "https://app.clickup.com/settings/apps" },
  hubspot_api_key: { label: "HubSpot API Key", placeholder: "pat-xxxxxxxxxxxx", helpUrl: "https://app.hubspot.com/settings/private-apps" },
  intercom_token: { label: "Intercom Access Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://app.intercom.com/a/apps/_/developer-hub" },
  zendesk_api_key: { label: "Zendesk API Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858" },
  amplitude_api_key: { label: "Amplitude API Key", placeholder: "xxxxxxxxxxxx", helpUrl: "https://analytics.amplitude.com/settings/profile" },
  mixpanel_token: { label: "Mixpanel Token", placeholder: "xxxxxxxxxxxx", helpUrl: "https://mixpanel.com/settings/project" },
  posthog_api_key: { label: "PostHog API Key", placeholder: "phx_xxxxxxxxxxxx", helpUrl: "https://app.posthog.com/settings/project-api-key" },
  airtable_api_key: { label: "Airtable API Key", placeholder: "patxxxxxxxxxxxx", helpUrl: "https://airtable.com/create/tokens" },
  salesforce_token: { label: "Salesforce Token", placeholder: "xxxxxxxxxxxx" },
  shopify_access_token: { label: "Shopify Access Token", placeholder: "shpat_xxxxxxxxxxxx", helpUrl: "https://admin.shopify.com/settings/apps/development" },
  mailchimp_api_key: { label: "Mailchimp API Key", placeholder: "xxxxxxxxxxxx-us1", helpUrl: "https://admin.mailchimp.com/account/api/" },
  // Other
  exa_api_key: { label: "Exa API Key", placeholder: "exa-xxxxxxxxxxxxxxxx", helpUrl: "https://dashboard.exa.ai/api-keys" },
  elevenlabs_api_key: { label: "ElevenLabs API Key", placeholder: "el_xxxxxxxxxxxxxxxx", helpUrl: "https://elevenlabs.io/app/settings/api-keys" },
};

export default function SecretInput({ credentialKey, label, placeholder, helpUrl, onSaved }: Props) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  const hint = ENV_VAR_HELP[credentialKey.toLowerCase()];
  const displayLabel = label || hint?.label || credentialKey.toUpperCase();
  const displayPlaceholder = placeholder || hint?.placeholder || "Paste your key here";
  const displayHelpUrl = helpUrl || hint?.helpUrl;

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    setStatus("idle");
    try {
      await apiPut(`/me/credentials/${credentialKey}`, { value: value.trim() });
      setStatus("saved");
      setValue("");
      onSaved(credentialKey);
    } catch (err) {
      setStatus("error");
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (status === "saved") {
    return (
      <div className="my-2 rounded-xl border border-green-800 bg-green-950/50 px-4 py-3">
        <p className="text-sm text-green-400">
          <span className="font-mono">{credentialKey.toUpperCase()}</span> saved securely
        </p>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-gray-700 bg-gray-800/80 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-400">
          <span className="font-mono text-gray-300">{displayLabel}</span>
        </p>
        {displayHelpUrl && (
          <a
            href={displayHelpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            Get key &rarr;
          </a>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={displayPlaceholder}
          className="flex-1 rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500 font-mono"
          autoFocus
        />
        <button
          onClick={save}
          disabled={saving || !value.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mt-1.5">
        Stored encrypted. Set as <span className="font-mono text-gray-400">{credentialKey.toUpperCase()}</span> env var in agent sessions.
      </p>
      {status === "error" && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
