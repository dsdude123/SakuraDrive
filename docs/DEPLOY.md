# Deploying

CI builds the image, smoke-tests it, and pushes it to
`ghcr.io/dsdude123/sakuradrive`. Deploying is a pull and a restart — which is the
operation Portainer's stack update actually performs, and the reason it works now
where a locally built image made it fail.

## What gets published

The `docker` job in `.github/workflows/ci.yml` runs after the Node and agent tests
pass, so nothing reaches the registry that the tests did not pass on. A published
image is what every Windows host installs its agent from, so a broken one is not a
broken build — it is a broken fleet.

The job builds the image, loads it into the local daemon, starts it, and checks that
it serves `/api/health`, that Kopia is present and that the agent source is really in
it. Only then does it retag and push, so the bytes in the registry are the bytes that
passed, not a second build assumed to be identical.

| Tag | When |
| --- | --- |
| `latest` | Every push to the default branch |
| `sha-<short sha>` | Every push to the default branch. What you pin to when rolling back |
| `1.2.3`, `1.2` | A `v1.2.3` git tag |

Every other branch still builds and smoke-tests; it just does not become what the NAS
pulls.

`/api/health` reports the commit the running image was built from, so "did my update
land?" is answerable without reading logs:

```bash
curl -s http://tokyo-3-wsl:8099/api/health
```

## Portainer

The package is private, like the repository, so Portainer needs a credential before it
can pull.

1. On GitHub, create a personal access token (classic) with the **`read:packages`**
   scope and nothing else. A fine-grained token cannot read GHCR packages.
2. In Portainer: **Registries → Add registry → Custom registry**.
   - URL: `ghcr.io`
   - Username: your GitHub username
   - Password: the token
3. **Stacks → sakuradrive → Update the stack**, with *Re-pull image* on.

That is the whole loop from then on: merge to the default branch, wait for CI, click
update.

If the pull fails with `denied` or `unauthorized`, the token is the thing to check
first — an expired one gives the same error as no credential at all.

## From the command line

```bash
cd ~/SakuraDrive/docker
docker compose pull
docker compose up -d
```

`pull_policy: always` means a plain `up -d` also fetches the current image, so the
explicit pull is belt and braces.

### Rolling back

Every push to the default branch leaves a `sha-` tag behind, so going back is pinning
to one:

```bash
SAKURADRIVE_TAG=sha-abc1234 docker compose up -d
```

Put it in `docker/.env` to make it stick across restarts, and delete the line to
follow `latest` again. Agents follow the server: roll the server back and every host
rolls its agent back with it, on its next run.

## Building from source

For working on SakuraDrive, or for a host that cannot reach GHCR:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.build.yml \
  up -d --build
```

The override adds the `build:` section and sets `pull_policy: build`, so Compose never
looks for the image in a registry. It keeps the registry image name, so the two paths
produce one container rather than two.

## Where the database lives

On the WSL2 VM's own filesystem, as a named Docker volume — **never** under `/mnt`.

Everything under `/mnt` is a Windows drive reached through drvfs, and SQLite on drvfs
is punishing: every page the cache misses is a round trip out to the Windows
filesystem. A real pool's catalog is gigabytes, so that is most reads. Adding up the
dashboard's totals took **85 seconds** on a drvfs mount and a millisecond off it.

Nothing irreplaceable is in there. The catalog is rebuilt by a scan, and export bundles
are copied out to the bind mount that reaches Backblaze.

### Moving an existing installation off drvfs

If `/data` is currently a bind mount under `/mnt`, copy it across once:

```bash
cd ~/SakuraDrive/docker
docker compose down

# Create the volume and copy the old data in.
docker volume create docker_sakuradrive_data
docker run --rm \
  -v /mnt/m/Tier2/Docker/sakuradrive_data:/from:ro \
  -v docker_sakuradrive_data:/to \
  alpine sh -c 'cp -a /from/. /to/'

docker compose up -d
```

The old directory is left untouched, so you can put the bind mount back if you want to.
Check it worked — the startup line reports the database size:

```bash
docker logs sakuradrive 2>&1 | head -1
```

Starting fresh instead is also fine: delete nothing, let the agent re-scan, and the
catalog rebuilds. Only the change history and dismissed bit-rot findings are lost.

## After deploying

Nothing on the Windows host. The agent asks `/api/agent/dist` on its next run,
sees a version it does not have, verifies every file against the published hashes and
replaces itself. **Settings → Agents** shows which distribution each host is on.

The exception is a host with no agent yet, or one installed before the agent could
update itself — that needs the install command from **Settings → Agents** once. See
[the agent guide](AGENT.md).
