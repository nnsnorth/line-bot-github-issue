# LINE Bot GitHub Issue Creator

LINE Messaging API webhook server that receives support requests via `@support <description>`, classifies them using a Python ML classifier, and creates GitHub issues with auto-populated project fields.

## Architecture

- **Webhook Service**: Node.js 24 / Express.js (ES Modules)
- **Classifier Service**: Python 3.11 / FastAPI with k-NN text embedding (paraphrase-multilingual-MiniLM-L12-v2)
- **Deployment**: Google Cloud Run (containerized), auto-deployed via GitHub Actions
- **Integrations**: LINE Messaging API, GitHub GraphQL API, GCP Secret Manager

## Project Structure

```
server.js          # Local dev server (port 3000)
index.js           # Google Cloud Functions entry point
src/
  app.js           # Express app setup
  config.js        # Environment config & validation
  classifier.js    # Classifier API client
  github.js        # GitHub GraphQL integration
  fieldCache.js    # Project field metadata caching
  lineHandler.js   # LINE webhook handler
  octokit.js       # GitHub App authentication
classifier/
  main.py          # FastAPI classifier server
  classify.py      # k-NN embedding classifier
  examples.json    # Training examples (Thai/multilingual)
```

## Development

```bash
cp .env.example .env   # Fill in credentials
npm install
npm run dev            # Runs node --watch server.js
```

### Key Commands

- `npm start` — Production server
- `npm run dev` — Dev server with file watching
- `npm run deploy` — Deploy to Google Cloud Functions

### Environment Variables

Required: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_OWNER`, `GITHUB_REPO`

Optional: `GITHUB_PROJECT_NUMBER`, `CLASSIFIER_URL`, `CONFIDENCE_THRESHOLD` (default 0.70), `PORT` (default 3000)

## Deployment

- Push to `main` → deploys to production via GitHub Actions
- Push to `dev` → deploys to staging
- Classifier deploys separately when `classifier/` changes

## Code Conventions

- ES Modules (`import`/`export`)
- Async/await with parallel `Promise.all()` for GraphQL mutations
- LINE signature verification via HMAC-SHA256 on raw body
- Immediate 200 response, async event processing
- No linter/formatter or test framework configured
