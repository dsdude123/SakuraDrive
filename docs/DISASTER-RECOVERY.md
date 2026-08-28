# Disaster recovery

The runbook this tool exists for.

## Before anything goes wrong

Three things need to be true, and it is worth checking them today rather than finding out
later:

1. **Catalog each pool disk separately.** Add the pool itself as a `pool` root, and each
   member disk as a `poolpart` root with the same pool id. This is what turns "roughly
   this much was unduplicated" into an exact list of files.
2. **Automatic exports are writing somewhere off-box.** Settings → Backup & export. If
   this container's storage dies with the array, the catalog goes with it. Check that
   *Recent exports* shows a verified bundle within the last day.
3. **The schedule leaves enough time to finish.** A catalog scan that never completes
   never applies deletions, and a hash pass that never completes never re-verifies
   anything. Workflows → *Last run* should show completions, not an endless chain of
   pauses.

## A disk has failed

### 1. Find out what is missing

Run a catalog scan of the **pool** root — Workflows → Catalog scan → *Run now*. It
ignores the schedule.

Then open **Catalog → Differences** and pick that run. Everything the disk took with it
appears as `deleted`. Export the CSV; that file is the definitive answer to "what is
missing from the pool now", and you want it somewhere other than this container.

SakuraDrive will also have raised a critical alert of its own: one scan marking more than
10% of a root as deleted is flagged, precisely because a dead disk and an unmounted share
look identical from inside a container.

### 2. Work out what is recoverable

**Disaster recovery** page, select the failed disk. It splits its contents into:

- **Would be lost** — files with no copy on any other pool part. These need a backup.
- **Survives in the pool** — duplicated elsewhere; DrivePool will re-balance them.

If the disk's `PoolPart.*` folder was catalogued as its own root, these numbers are
exact. If not, the page says so and falls back to configured duplication levels — which
can only tell you what *should* have had a second copy.

### 3. Check the backup

**Backup health** → *Verify now*. Cross-reference the unrecoverable list against what is
actually in Kopia. Anything in both lists is a restore; anything in the first but not the
second is genuinely gone, and worth knowing before you start.

### 4. Replace the disk

Add the replacement to the pool in DrivePool and let it re-balance. Then:

- Update the `poolpart` root in **Settings → Catalog roots** to point at the new disk's
  mount, and set its drive label.
- Run a catalog scan so the new layout is recorded.
- Run the bit-rot scan so the restored files get baseline hashes.

## The SakuraDrive container is gone

Rebuild it and import the most recent export bundle.

```bash
cd sakuradrive/docker
docker compose up -d --build
```

Open the interface, create an account, then **Settings → Backup & export → Import a
bundle**. Choose *Replace* mode and tick *Also import settings*.

If the bundle is already inside the container — restored from Backblaze into a mounted
folder, say — you can point at it by path instead of uploading:

```bash
curl -X POST --cookie "sd_session=..." \
  "http://localhost:8080/api/export/import?mode=replace&importSettings=true&path=/backup/sakuradrive/sakuradrive-2024-03-05.ndjson.gz"
```

Credentials are redacted from bundles by default, so re-enter the Kopia repository
password and the Discord webhook afterwards.

## Bit rot was found

A finding means the file's content changed while its size and modification time did not.
Nothing legitimate does that.

1. **Restore the file from Kopia.** The finding carries the expected hash — the one
   recorded when the file was last known good — so you can verify the restore matches.
2. Mark the finding **resolved** with a note. The next hash of that file records its new
   content as the reference.
3. If findings cluster on one disk, look at that disk's SMART page. Reallocated,
   pending or offline-uncorrectable sectors climbing alongside bit-rot findings is a disk
   that should be replaced, not a file that should be restored.

Dismiss rather than resolve when the change is explained — some applications rewrite
files while deliberately preserving their timestamp. A dismissed finding stops counting
as a problem but stays in the history.

## Verifying the plan without a disaster

Worth doing once:

1. Export a bundle and download it.
2. Start a second container on a different port with an empty volume.
3. Import the bundle in *Replace* mode.
4. Confirm the catalog, drive history and bit-rot findings all came across.

That exercises the whole recovery path while nothing is actually on fire.
