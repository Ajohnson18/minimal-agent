---
name: github
description: Query and manage GitHub repositories - list repos, check CI status, create issues, search repos, and view recent activity.
---

# GitHub Skill

## Authentication

If `GITHUB_TOKEN` is already set in the environment (from stored credentials), use it directly — do NOT run the auth script.

Only if `GITHUB_TOKEN` is **not** set, generate one via the GitHub App:

```bash
eval $(bash {baseDir}/github-app-auth.sh 2>/dev/null)
```

Then use the token with the GitHub API:

```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" https://api.github.com/...
```

## Common Operations

### List repos
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/installation/repositories?per_page=30"
```

### Get repo details
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/withlink/REPO_NAME"
```

### Check CI status
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/withlink/REPO_NAME/actions/runs?per_page=5"
```

### Create issue
```bash
curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/withlink/REPO_NAME/issues" \
  -d '{"title":"Issue title","body":"Description"}'
```

### Create PR
```bash
curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/withlink/REPO_NAME/pulls" \
  -d '{"title":"PR title","head":"branch","base":"main","body":"Description"}'
```

### Recent commits
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/withlink/REPO_NAME/commits?per_page=10"
```

## Permissions

- Contents: Read & Write
- Issues: Read & Write  
- Pull Requests: Read & Write
- Actions: Read-only
- Metadata: Read-only

## App Details

- App: [xava-bot](https://github.com/apps/xava-bot)
- App ID: 2871746
- Org: withlink
- Installation ID: 110323001
- Private key: `~/.ava/secrets/xava-bot.pem`
