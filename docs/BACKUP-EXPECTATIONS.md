# Backup expectations

SakuraDrive does not assume everything is backed up. Cloud storage costs money and some
of this data is replaceable, so what *should* be in the repository is something you
state, and verification checks the catalog against it.

An expectation answers four questions:

| Field | Question |
| --- | --- |
| Catalog root | Whose files are we talking about? |
| Include / exclude globs | Which of them are meant to be backed up? |
| Kopia source | Which snapshot should they be in? |
| The two prefixes | How does a catalog path become a path inside that snapshot? |

Everything the rules do **not** claim is listed on the Backup health page under "What
the rules cover". It raises no alert — leaving a folder out is a decision, not a fault —
but it is visible, which is the point. The moment you want that list is the morning a
disk has died, and that is too late to work it out.

## The two prefixes

The catalog and the snapshot rarely start at the same folder, and they can differ in
either direction.

**Catalog path prefix** — the snapshot starts *deeper* than the catalog root. A source
of `J:\Tier1` against a root catalogued from `J:\` needs `Tier1` here: it is stripped
from catalog paths to get the snapshot path, and files outside it are not expected in
this snapshot at all.

```
catalog   Tier1/Movies/a.mkv
prefix    Tier1
snapshot  Movies/a.mkv
```

**Snapshot path prefix** — the snapshot starts *higher*. Snapshotting a whole pool
member disk captures `PoolPart.<guid>\Tier1\...`, while the catalog strips that folder
from a pool part's paths, so it has to be put back:

```
catalog   Tier1/Movies/a.mkv
prefix    PoolPart.*
snapshot  PoolPart.d304fce8-.../Tier1/Movies/a.mkv
```

Write it as `PoolPart.*` and the wildcard is resolved against the snapshot's own top
level. The pool GUID never enters the configuration, and the rule keeps working after
DrivePool is removed and re-added to a disk — which changes that GUID.

## Worked example: this host

Kopia currently holds snapshots for `C:\Users`, `D:`, `E:`, `F:`, `J:\AmpDatastore`,
`J:\Tier0`, `J:\Tier1` and `M:\Tier1`. Mapped onto the catalog roots:

| Catalog root | Kopia source | Catalog prefix | Snapshot prefix | Include |
| --- | --- | --- | --- | --- |
| `ssd-bay1` (F:) | `F:\` | — | `PoolPart.*` | `**` |
| `ssd-bay2` (E:) | `E:\` | — | `PoolPart.*` | `**` |
| `ssd-bay3` (D:) | `D:\` | — | `PoolPart.*` | `**` |
| each HDD pool part | `J:\Tier0` | `Tier0` | — | `Tier0/**` |
| each HDD pool part | `J:\Tier1` | `Tier1` | — | `Tier1/**` |
| each HDD pool part | `J:\AmpDatastore` | `AmpDatastore` | — | `AmpDatastore/**` |

Two things fall out of that list, and both are worth knowing deliberately rather than
discovering later:

- **The SSD pool is fully covered.** D, E and F are snapshotted whole, so everything in
  the pool is in the repository — including both copies of a duplicated file, which
  Kopia deduplicates by content anyway. `M:\Tier1` is the pooled view of the same data
  and is therefore redundant with them; harmless, but it is not extra protection.
- **`J:\Tier2`, `Tier3` and `Tier4` are not backed up at all.** If one of the fourteen
  HDD pool disks dies, whatever it held in those tiers that was not duplicated is gone.
  The Disaster recovery page tells you exactly which files those are, per disk, and the
  coverage table says the same thing in advance.

The HDD pool needs one expectation per *pool part*, not one for the pool: verification
works from catalogued roots, and the pool is a view over its members rather than a
scanned tree of its own. The rules are otherwise identical, so copy the first one.

## Snapshot age

`maxSnapshotAgeHours` flags a file whose backed-up copy is older than the catalog's, by
more than that many hours. The default of 192 (eight days) suits a weekly snapshot with
room for one to be missed. Tighten it for anything that changes daily.
