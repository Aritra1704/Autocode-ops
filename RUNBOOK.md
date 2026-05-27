# Stallone Runbook

Everything you need to start, test, and interact with Stallone.

---

## Prerequisites

| Requirement | Check | Install |
|-------------|-------|---------|
| Node.js 20+ | `node --version` | https://nodejs.org |
| Docker Desktop | `docker info` | https://docker.com |
| Ollama | `ollama --version` | https://ollama.com |
| qwen2.5-coder:7b | `ollama list` | `ollama pull qwen2.5-coder:7b` |
| llama3.2:3b | `ollama list` | `ollama pull llama3.2:3b` |

---

## 1. First-Time Setup

### Start the database
```bash
cd /Users/aritrarpal/Documents/workspace_biz/stallone

# Start postgres (uses port 54329 — same as LocalClaw, different schema)
docker compose up -d postgres

# Wait for healthy
docker ps | grep stallone-postgres
```

### Install dependencies
```bash
npm install
```

### Run migrations (creates the `stallone` schema)
```bash
npm run migrate
```

You should see 14 migrations applied on first run, then "Database migrations are up to date."

### Configure your .env
`.env` is already set up at `stallone/.env`. The key fields:
```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/localclaw
DATABASE_SCHEMA=stallone
GEMINI_API_KEY=<your key>
OLLAMA_BASE_URL=http://127.0.0.1:11434
STALLONE_WORKSPACE_ROOT=/Users/aritrarpal/Documents/workspace_biz
CONTROL_API_PORT=4174
```

---

## 2. Starting Stallone

### Development (recommended — live logs, auto-restart on file change)
```bash
npm run dev
```

### Production (background process via PM2)
```bash
npm install -g pm2        # first time only
pm2 start pm2.config.cjs
pm2 logs stallone         # tail logs
pm2 stop stallone         # stop
pm2 restart stallone      # restart
```

### One-shot (foreground, Ctrl+C to stop)
```bash
npm start
```

**Healthy boot output looks like:**
```
Database connection verified   ← schema_name: stallone
RAG corpus sync initialized
Control API started            ← address: 127.0.0.1:4174
Stallone is running            ← mode: hybrid, workspace: /workspace_biz
```

---

## 3. Submitting Tasks

Stallone polls the `tasks` table every 5 seconds. There are four ways to give it work.

### Option A — Control API (recommended)

```bash
curl -s -X POST http://127.0.0.1:4174/v1/tasks/run \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Write a hello world file",
    "description": "Create a file called hello.txt containing: Hello from Stallone!",
    "priority": "high",
    "projectPath": "/Users/aritrarpal/Documents/workspace_biz/stallone-test"
  }' | jq .
```

### Option B — Direct DB insert (simplest, no API needed)

```bash
docker exec -it stallone-postgres psql -U postgres -d localclaw -c "
SET search_path TO stallone, public;
INSERT INTO tasks (title, description, priority, status, project_path, source)
VALUES (
  'Write a hello world file',
  'Create a file called hello.txt in the project root containing: Hello from Stallone!',
  'high',
  'pending',
  '/Users/aritrarpal/Documents/workspace_biz/stallone-test',
  'manual'
) RETURNING id, title, status;
"
```

### Option C — CLI (requires Stallone running)

```bash
# Check status
npm run cli -- status

# List tasks
npm run cli -- tasks

# Interactive chat to plan + submit
npm run cli -- chat
```

### Option D — Telegram bot (if TELEGRAM_BOT_TOKEN is set)

Send a message to your bot:
```
/tasks          — list current tasks
/status         — engine state
/online         — mark yourself as online (Stallone will delegate to you)
/offline        — mark yourself as offline (Stallone works autonomously)
/done           — signal you've pushed your commit on a delegated step
/pause reason   — pause the engine
/resume         — resume
/kill reason    — emergency stop
```

---

## 4. Watching a Task Execute

Once a task is submitted, you'll see this in the logs:

```
Starting task                            ← picked up from queue
run_ollama succeeded. Decision: write    ← Ollama wrote the file
Commit: abc1234                          ← git committed
Task finished  success: true             ← done
```

### Verify the result

```bash
# See what Stallone wrote
cat /Users/aritrarpal/Documents/workspace_biz/stallone-test/hello.txt

# See the git commit Stallone made
git -C /Users/aritrarpal/Documents/workspace_biz/stallone-test log --oneline
```

### Check task status in DB

```bash
docker exec -it stallone-postgres psql -U postgres -d localclaw -c "
SET search_path TO stallone, public;
SELECT id, title, status, started_at, completed_at
FROM tasks ORDER BY created_at DESC LIMIT 5;
"
```

---

## 5. Error Scenarios

| Log message | Cause | Fix |
|-------------|-------|-----|
| `run_ollama failed after 3 attempts` | Ollama not running or model missing | `ollama serve` + `ollama pull qwen2.5-coder:7b` |
| `Gemini call failed` | Bad API key or network | Check `GEMINI_API_KEY` in `.env` |
| `nothing to commit` | File wasn't written or no changes | Check Ollama response; retry task |
| `DB NOT REACHABLE` | Postgres not running | `docker compose up -d postgres` |
| `EADDRINUSE :4174` | Port taken by another process | Change `CONTROL_API_PORT` in `.env` |
| `Reached maximum steps (30)` | Task too complex for one loop | Break into smaller tasks |

---

## 6. Interacting While Stallone is Running

### Control API endpoints

All endpoints at `http://127.0.0.1:4174`

```bash
# Health check
curl http://127.0.0.1:4174/health

# Engine status
curl http://127.0.0.1:4174/v1/status | jq .

# List tasks
curl http://127.0.0.1:4174/v1/tasks | jq .

# List skills
curl http://127.0.0.1:4174/v1/skills | jq .

# Pause the engine
curl -X POST http://127.0.0.1:4174/v1/pause \
  -H "Content-Type: application/json" \
  -d '{"reason": "manual pause"}'

# Resume
curl -X POST http://127.0.0.1:4174/v1/resume

# Record a dashboard presence ping (marks you as online)
curl -X POST http://127.0.0.1:4174/v1/presence/ping
```

### CLI commands

```bash
npm run cli -- status           # engine state
npm run cli -- tasks            # list recent tasks
npm run cli -- skills           # list all skills
npm run cli -- approvals        # list pending approvals
npm run cli -- doctor           # full health check
npm run cli -- chat             # interactive planning chat with Gemini
npm run cli -- pause "reason"   # pause engine
npm run cli -- resume           # resume engine
```

---

## 7. Human Collaboration (Online Mode)

When you're available and want Stallone to delegate hard steps to you:

**Tell Stallone you're online:**
- Telegram: `/online`
- Or: `curl -X POST http://127.0.0.1:4174/v1/presence/ping`

**Stallone will:**
1. Detect your presence score ≥ 0.5
2. When it hits a step that needs human judgment, send you a Telegram message
3. Wait up to 60 minutes for you to push a git commit
4. Detect your commit and continue automatically

**When you've finished your part:**
- Telegram: `/done`
- Or just push a commit — Stallone watches git for it

**Tell Stallone you're going offline:**
- Telegram: `/offline`
- Stallone will work fully autonomously again

---

## 8. Managing Skills

Stallone learns. When the same task pattern succeeds 3+ times with confidence ≥ 7, it auto-generates a skill in `skills/generated/`.

**List built-in skills:**
```bash
ls skills/builtin/
```

**List auto-generated skills:**
```bash
ls skills/generated/ 2>/dev/null || echo "None yet"
```

**Trigger a skill manually (via task description):**
Include the skill name in the task description and Stallone will call `run_skill` automatically.

---

## 9. Keeping Stallone Running 24/7

```bash
# Start with PM2 (survives reboots)
pm2 start pm2.config.cjs
pm2 save
pm2 startup    # follow the printed command to enable on boot

# Check it's running
pm2 status

# Tail live logs
pm2 logs stallone --lines 50

# Restart after pulling updates
pm2 restart stallone
```

---

## 10. Quick Reference

| Action | Command |
|--------|---------|
| Start (dev) | `npm run dev` |
| Start (prod) | `pm2 start pm2.config.cjs` |
| Start DB | `docker compose up -d postgres` |
| Migrate | `npm run migrate` |
| Submit task | see Section 3 |
| Check logs | `pm2 logs stallone` |
| Pause | `curl -X POST http://127.0.0.1:4174/v1/pause -d '{"reason":"..."}'` |
| Resume | `curl -X POST http://127.0.0.1:4174/v1/resume` |
| Health | `curl http://127.0.0.1:4174/health` |
| Mark online | Telegram `/online` or POST `/v1/presence/ping` |
| Mark offline | Telegram `/offline` |
