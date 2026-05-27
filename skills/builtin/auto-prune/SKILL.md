# Skill: Auto-Prune

**Version:** 1.0.0  
**Role:** cleanup  
**Description:** Automatically cleans up temporary files, old logs, and redundant build artifacts to free up space.

## Targets
- `/Volumes/Ari_SSD_01/PROJECTS/localclaw/**/node_modules` (unused for 30+ days)
- `/Volumes/Ari_SSD_01/PROJECTS/localclaw/**/dist`
- `/Volumes/Ari_SSD_01/PROJECTS/localclaw/**/.cache`
- `localclaw/logs/*.log` (older than 7 days)
- `localclaw/db/backups/*.sql` (older than 14 days)

## Governance
- Requires confirmation if deleting more than 5GB of data.
- Never deletes active project source code.
- Never deletes the primary `.env` file or SQLite/Postgres data.
