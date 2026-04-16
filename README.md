# LINE Bot GitHub Issue Creator

A LINE OA webhook server that receives support requests, classifies them using a multilingual ML model (k-NN + sentence embeddings), and automatically creates GitHub issues with project fields pre-populated — severity, category, issue type, SLA deadline, and more. Deployable to Google Cloud Run.

## How It Works

A user sends a message to the LINE bot:

```
@support แอปเชื่อมต่อไม่ได้ / app not connecting
```

The bot then:

1. Calls the classifier to detect **tenant**, **product**, **issue type**, **category**, and **severity**
2. Prompts the user (via quick replies) for anything it couldn't confidently detect
3. Creates a GitHub issue with a structured body
4. Adds the issue to a GitHub Project V2 with all fields pre-populated
5. Sets a **resolution SLA** date based on severity (S1: 8 hrs, S2: 2 days, S3: 5 days)

If the classifier is confident (≥ 70% on all fields), the issue goes straight to **triaged** status. Otherwise it lands in **inbox** for manual review.

### Group Chat Support

In LINE group chats, the bot responds to @mentions and automatically assigns the tenant from `LINE_GROUP_TENANT_MAP` — no user prompt needed.

---

## Architecture

```
LINE Messaging API
       │
       ▼
┌─────────────────────────────────┐
│  Webhook Service (Node.js 24)   │  ← Cloud Run
│  Express.js / ES Modules        │
│  • Verifies LINE signature      │
│  • Orchestrates flow            │
│  • Calls GitHub GraphQL API     │
└────────────┬────────────────────┘
             │ HTTP (auth)
             ▼
┌─────────────────────────────────┐
│  Classifier Service (Python)    │  ← Cloud Run (separate)
│  FastAPI + k-NN embeddings      │
│  • paraphrase-multilingual-     │
│    MiniLM-L12-v2                │
│  • Returns issue_type,          │
│    category, severity,          │
│    product, tenant              │
└─────────────────────────────────┘
```

**Stack:**
- Webhook: Node.js 24, Express.js, ES Modules
- Classifier: Python 3.11, FastAPI, fastembed
- Deployment: Google Cloud Run, GitHub Actions CI/CD
- Secrets: GCP Secret Manager
- GitHub: App auth (Octokit), GraphQL API, Projects V2

---

## Project Structure

```
server.js               # Entry point (port 3000)
src/
  app.js                # Express app, /health and /webhook routes
  lineHandler.js        # Main webhook logic (tenant → product → issue)
  lineClient.js         # LINE API calls (verify, reply, profiles)
  labelSelection.js     # Quick-reply UI, stateless postback encoding
  classifier.js         # Classifier API client
  github.js             # GitHub GraphQL: create issue, add to project
  fieldCache.js         # Caches GitHub project field metadata
  octokit.js            # GitHub App auth
  config.js             # Env var loading & validation
classifier/
  main.py               # FastAPI server (/health, /classify)
  classify.py           # k-NN classifier logic
  examples.json         # Training data (Thai + English)
  Dockerfile            # Python 3.11, pre-downloads model at build time
  requirements.txt
.github/workflows/
  test.yml              # Run tests on push/PR
  deploy.yml            # Deploy webhook to Cloud Run (prod)
  deploy-dev.yml        # Deploy webhook to Cloud Run (dev/staging)
  deploy-classifier.yml # Deploy classifier to Cloud Run (prod)
  deploy-classifier-dev.yml
  refresh-cache.yml     # Weekly Docker layer cache refresh
```

---

## GitHub Issue Output

Each issue is created with a structured body:

```
Reporter:   John Doe
Tenant:     Hospital A  (confidence: 95%)
Product:    Connect     (confidence: 100%)
Issue Type: Incident    (confidence: 88%)
Category:   Connectivity (confidence: 91%)
Severity:   S2          (confidence: 82%)

Description:
<original message text>
```

**GitHub Project V2 fields auto-populated:**

| Field | Example Values | Source |
|---|---|---|
| status | triaged / inbox | All fields confident? → triaged |
| severity | S1, S2, S3, S4 | Classifier |
| category | connectivity, payment, training… | Classifier |
| issue_type | incident/bug, feedback, feature request | Classifier |
| product | connect, phr, dashboard, other | Keyword match or classifier |
| tenant | Hospital A, Clinic B… | Group map, classifier, or user pick |
| reporter | LINE display name | LINE profile API |
| resolution_sla | 2026-04-18 | S1: +8 hrs, S2: +2 days, S3: +5 days |

---

## Classifier

The classifier uses **k-NN with sentence embeddings** (`paraphrase-multilingual-MiniLM-L12-v2`) — a 12-layer multilingual model that supports Thai and English out of the box.

**How it classifies:**
1. Embeds the incoming message and all training examples
2. Finds the top-3 most similar examples (cosine similarity)
3. Weighted vote: each neighbor's label is weighted by its similarity score
4. Confidence = `(winning_label_score / total_score) × top_similarity`

**Training data** lives in `classifier/examples.json` — an array of labeled examples:

```json
[
  {
    "text": "แอปเชื่อมต่อไม่ได้",
    "product": "connect",
    "issue_type": "incident/bug",
    "category": "connectivity",
    "severity": "S2",
    "tenant": "hospital_a"
  }
]
```

Add more examples to improve accuracy. Redeploy the classifier after changes.

**Keyword detection** (exact match, confidence = 1.0) handles product/tenant before calling k-NN — configurable in `classify.py`.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/line-bot-github-issue
cd line-bot-github-issue
npm install
```

### 2. Configure environment

```bash
cp .env.dev.example .env
# Fill in the required values (see below)
```

### 3. Run locally

```bash
npm run dev       # Node --watch (auto-reload)
npm start         # Production mode
```

The webhook listens at `http://localhost:3000/webhook`.

Use [ngrok](https://ngrok.com/) or a similar tunnel to expose it to LINE's servers during development.

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key or base64-encoded PEM |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID for the target org/repo |
| `GITHUB_OWNER` | GitHub org or username |
| `GITHUB_REPO` | Repository name |

### LINE (optional but needed for full functionality)

| Variable | Description |
|---|---|
| `LINE_CHANNEL_SECRET` | Used for HMAC-SHA256 webhook signature verification |
| `LINE_CHANNEL_ACCESS_TOKEN` | Bot token for sending replies and fetching profiles |

### Optional

| Variable | Default | Description |
|---|---|---|
| `GITHUB_PROJECT_NUMBER` | — | Project V2 number (from URL). Skip to disable project integration |
| `CLASSIFIER_URL` | — | Classifier Cloud Run URL. Skip to create plain issues without labels |
| `CONFIDENCE_THRESHOLD` | `0.70` | Min confidence (0–1) to auto-fill product/tenant without prompting |
| `LINE_GROUP_TENANT_MAP` | — | JSON: `{"tenant_a": ["C123...", "C456..."]}` maps group IDs to tenants |
| `PORT` | `3000` | Server port (Cloud Run uses 8080) |

---

## Deployment

Deployments are triggered automatically via GitHub Actions.

| Push to branch | Effect |
|---|---|
| `main` | Deploy webhook + classifier to **production** Cloud Run |
| `dev` | Deploy to **staging** Cloud Run |

The classifier only redeploys when files under `classifier/` change.

### GitHub Secrets (set in repo settings)

| Secret | Description |
|---|---|
| `GCP_SA_KEY` | GCP service account JSON with Cloud Run deploy permissions |
| `LINE_CHANNEL_SECRET_PROD` | Secret Manager secret name |
| `LINE_CHANNEL_ACCESS_TOKEN_PROD` | Secret Manager secret name |
| `GITHUB_APP_PRIVATE_KEY` | Secret Manager secret name |
| `LINE_GROUP_TENANT_MAP` | Secret Manager secret name |

### GitHub Variables (set in repo settings)

| Variable | Example |
|---|---|
| `SERVICE_NAME` | `line-webhook` |
| `GCP_REGION` | `asia-southeast1` |
| `GCP_PROJECT_ID` | `my-gcp-project` |
| `ARTIFACT_REGISTRY_IMAGE` | `asia-southeast1-docker.pkg.dev/my-project/my-repo/webhook` |
| `CLASSIFIER_IMAGE` | `asia-southeast1-docker.pkg.dev/my-project/my-repo/classifier` |
| `CLASSIFIER_SERVICE_NAME` | `line-classifier` |
| `CLASSIFIER_URL` | `https://line-classifier-xxxxx-as.a.run.app` |
| `GITHUB_APP_ID` | `123456` |
| `GITHUB_APP_INSTALLATION_ID` | `78901234` |
| `GITHUB_OWNER` | `my-org` |
| `GITHUB_REPO` | `support` |
| `GITHUB_PROJECT_NUMBER` | `5` |

### Cloud Run specs

| Service | Memory | CPU | Instances |
|---|---|---|---|
| Webhook | 256 Mi | 1 | 0–10 |
| Classifier | 2 Gi | 1 | 0–2 |

The classifier endpoint is **private** (requires GCP identity token). The webhook fetches a token automatically at request time.

---

## Adding Training Examples

1. Edit `classifier/examples.json` — add objects with `text`, `product`, `issue_type`, `category`, `severity`, `tenant`
2. Push the change → classifier auto-redeploys via GitHub Actions
3. No code changes needed

---

## License

MIT
