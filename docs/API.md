# API reference

Everything the web interface does goes through this API, so anything in the UI can be
scripted.

**Authentication.** Browser endpoints use a `sd_session` cookie from
`POST /api/auth/login`. The agent endpoint uses `Authorization: Bearer <agent token>`
instead. `SAKURADRIVE_DISABLE_AUTH=true` bypasses the session check entirely — agent
tokens are still required.

```bash
curl -c jar -X POST http://nas:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"…"}'
curl -b jar http://nas:8080/api/dashboard
```

Errors are `{ "error": "<code>", "message": "<human readable>", "details"?: … }` with a
matching HTTP status.

## Health and authentication

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | No authentication. Used by the Docker healthcheck |
| GET | `/api/auth/status` | Whether setup is needed, who is signed in, the version |
| POST | `/api/auth/setup` | Creates the first account. 409 once one exists |
| POST | `/api/auth/login` | `{username, password}` |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/password` | `{currentPassword, newPassword}`. Invalidates every session |

## Agents

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/agent/report` | Bearer token. Body is `agentReportSchema` |
| POST | `/api/agent/jobs/claim` | Bearer token. Returns a job, or 204 when there is none |
| POST | `/api/agent/jobs/:id/batch` | Bearer token. Results, and whether to keep going |
| POST | `/api/agent/jobs/:id/finish` | Bearer token. Final state and cursor |
| GET | `/api/agent/dist` | Bearer token. The agent manifest: version, and every file with its SHA-256 |
| GET | `/api/agent/dist/file?path=…` | Bearer token. One file as bytes; only names in the manifest are served |
| GET | `/api/agents/dist` | What the interface renders the install command from |
| GET | `/api/agents/jobs` | What the agent is running, waiting on, and just finished |
| POST | `/api/agents/jobs/:id/cancel` | Ask a running job to stop at its next batch, or drop a queued one |
| GET | `/api/agents` | Reporting agents and their freshness |
| GET | `/api/agents/tokens` | Never returns token plaintext |
| POST | `/api/agents/tokens` | `{name}`. Returns the plaintext **once** |
| DELETE | `/api/agents/tokens/:id` | Revoke |

## Monitoring

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/dashboard` | Everything the dashboard shows, in one document |
| GET | `/api/drives` | Physical disks with labels, health and pool membership |
| GET | `/api/drives/:id` | Latest SMART, per-attribute history, latency samples |
| GET | `/api/drives.csv` | |
| GET | `/api/volumes` | Filesystem status including the NTFS dirty bit |
| GET | `/api/pools` | Pools and their parts |
| GET | `/api/primocache` | Most recent PrimoCache sample |

## Alerts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/alerts` | `?state=open\|resolved\|any&category=&severity=&search=&limit=&offset=` |
| GET | `/api/alerts/:id` | With its event history |
| POST | `/api/alerts/:id/acknowledge` | |
| POST | `/api/alerts/:id/unacknowledge` | |
| POST | `/api/alerts/:id/resolve` | Re-raised on the next collector run if still true |

## Workflows

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/workflows` | Status, window state, minutes to the next transition |
| GET | `/api/workflows/runs` | `?workflowId=&limit=` |
| GET | `/api/workflows/runs/:id` | Including the log tail |
| POST | `/api/workflows/:id/start` | `{force:true}` ignores the schedule. 409 if it cannot start |
| POST | `/api/workflows/:id/stop` | Cooperative: the run saves its cursor and pauses |

Workflow ids: `catalog.scan`, `catalog.hash`, `catalog.duplication`, `backup.verify`,
`export.backup`, `maintenance.prune`.

## Catalog

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/catalog/roots` | Configured roots with per-root statistics |
| GET | `/api/catalog/browse` | `?rootId=&path=&sort=size\|name&limit=&offset=` |
| GET | `/api/catalog/search` | `?rootId=&text=&ext=&minSizeBytes=&includeDeleted=` |
| GET | `/api/catalog/runs` | `?rootId=&limit=` |
| GET | `/api/catalog/runs/:runId/diff` | Created / modified / deleted counts and bytes |
| GET | `/api/catalog/changes` | `?runId=&rootId=&kind=&since=&search=` |
| GET | `/api/catalog/changes.csv` | Same filters. **The list to keep after a disk dies** |
| GET | `/api/catalog/orphaned` | Catalog data left by roots no longer configured |
| DELETE | `/api/catalog/roots/:rootId/data` | Purge that data. 409 while the root is still configured |

## Storage, bit rot and recovery

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/storage/treemap` | `?rootId=&path=&width=&height=&depth=&metric=effective\|logical` — returns laid-out rectangles |
| GET | `/api/bitrot` | `?status=active\|open\|confirmed\|dismissed\|resolved\|any` |
| POST | `/api/bitrot/status` | `{ids:[], status, note}` |
| GET | `/api/bitrot.csv` | |
| GET | `/api/dr/impact` | `?rootId=` — what a disk takes with it, plus the file list |
| GET | `/api/dr/impact.csv` | The full list, unpaginated |
| GET | `/api/dr/under-duplicated` | `?poolId=` — copies on fewer physical disks than configured |

`/api/dr/impact` treats a **physical disk** as the failure domain, not a pool part: any
other part on the same drive is listed in `sharedDiskRoots` and counted as lost with it,
and `siblingRoots` holds only the parts on other drives that a copy could survive on.

## Backup

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/backup/runs` | Verification history and the current summary |
| GET | `/api/backup/coverage` | Per root: which folders backup rules cover, and which they do not |

Expectations and the two path prefixes are explained in [BACKUP-EXPECTATIONS.md](BACKUP-EXPECTATIONS.md).
| GET | `/api/backup/issues` | `?runId=&kind=missing\|stale\|size-mismatch&status=` |
| POST | `/api/backup/issues/status` | `{ids:[], status, note}` |
| POST | `/api/settings/test-kopia` | Connects and lists visible snapshot sources |

## Settings

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/settings` | Credentials masked as `__REDACTED__` |
| PATCH | `/api/settings` | Deep merge. Sending the mask back keeps the stored secret. Arrays are replaced wholesale. Removing a root keeps its catalog; the response lists it under `orphanedRoots` |
| POST | `/api/settings/validate` | Validate without saving |
| PUT | `/api/settings/schedule` | `{heavyIo: string[7]}` of 24 `0`/`1` characters |
| GET | `/api/settings/check-path` | `?path=` — is this visible inside the container? |
| POST | `/api/settings/test-discord` | Sends a test message immediately |

## Export and import

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/exports` | History |
| POST | `/api/export/create` | Builds a bundle, returns a download URL |
| GET | `/api/export/download` | `?file=` — only from the export directory |
| POST | `/api/export/run-now` | Runs the scheduled export to every destination |
| POST | `/api/export/import` | Multipart upload, or `?path=` for a file in the container. `?mode=merge\|replace&importSettings=` |
| POST | `/api/export/inspect` | Reads a bundle's manifest without importing |
| GET | `/api/export/destinations/check` | Whether each destination is writable |

## Schedule format

Seven strings of 24 characters, index 0 = Sunday, `1` = heavy I/O allowed:

```json
{
  "heavyIo": [
    "011111111100000000000000",
    "011111100000000000000000",
    "011111100000000000000000",
    "011111100000000000000000",
    "011111100000000000000000",
    "011111100000000000000000",
    "011111111100000000000000"
  ]
}
```

Hours are interpreted in the timezone set under Settings → General, not the container's.
