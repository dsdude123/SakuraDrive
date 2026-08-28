import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  collapseSmall,
  effectiveSize,
  layoutTreemap,
  normalizeRelPath,
  type TreemapInput,
} from '@sakuradrive/shared';
import type { Services } from '../services/container.js';
import { intParam, parseBody, parseQuery, sendCsv, toCsv } from './helpers.js';

export function registerCatalogRoutes(app: FastifyInstance, services: Services): void {
  const { catalog, settings, bitrot } = services;

  app.get('/api/catalog/roots', async () => ({
    roots: settings.get().catalog.roots.map((root) => ({
      ...root,
      virtual: false,
      stats: catalog.rootStats(root.id),
    })),
    /**
     * Pools are views over their member disks rather than scanned roots, so they are
     * listed separately — browse, search and the storage map accept their ids exactly
     * like a real root's.
     */
    pools: catalog.virtualPools().map((pool) => ({
      id: pool.rootId,
      poolId: pool.poolId,
      name: pool.name,
      kind: 'pool' as const,
      virtual: true,
      partRootIds: pool.partRootIds,
      stats: catalog.rootStats(pool.rootId),
    })),
  }));

  app.get('/api/catalog/browse', async (request, reply) => {
    const query = parseQuery(
      z.object({
        rootId: z.string().min(1),
        path: z.string().default(''),
        sort: z.enum(['size', 'name']).default('size'),
        limit: intParam(500, 5000),
        offset: intParam(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    return {
      rootId: query.rootId,
      path: normalizeRelPath(query.path),
      ...catalog.listDirectory(query.rootId, query.path, query),
    };
  });

  app.get('/api/catalog/search', async (request, reply) => {
    const query = parseQuery(
      z.object({
        rootId: z.string().optional(),
        text: z.string().optional(),
        ext: z.string().optional(),
        minSizeBytes: intParam(0, Number.MAX_SAFE_INTEGER),
        includeDeleted: z.coerce.boolean().default(false),
        limit: intParam(200, 2000),
        offset: intParam(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    return catalog.searchFiles(query);
  });

  app.get('/api/catalog/runs', async (request, reply) => {
    const query = parseQuery(
      z.object({ rootId: z.string().optional(), limit: intParam(50, 200) }),
      request,
      reply,
    );
    if (!query) return reply;
    return { runs: catalog.listRuns(query.rootId, query.limit) };
  });

  app.get<{ Params: { runId: string } }>('/api/catalog/runs/:runId/diff', async (request) => ({
    summary: catalog.diffSummary(Number(request.params.runId)),
  }));

  app.get('/api/catalog/changes', async (request, reply) => {
    const query = parseQuery(
      z.object({
        runId: z.coerce.number().int().optional(),
        rootId: z.string().optional(),
        kind: z.enum(['created', 'modified', 'deleted', 'restored']).optional(),
        since: z.string().optional(),
        search: z.string().optional(),
        limit: intParam(500, 10_000),
        offset: intParam(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    return catalog.listChanges(query);
  });

  app.get('/api/catalog/changes.csv', async (request, reply) => {
    const query = parseQuery(
      z.object({
        runId: z.coerce.number().int().optional(),
        rootId: z.string().optional(),
        kind: z.enum(['created', 'modified', 'deleted', 'restored']).optional(),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    const { changes } = catalog.listChanges({ ...query, limit: 10_000 });
    sendCsv(
      reply,
      'sakuradrive-changes.csv',
      toCsv(
        ['root', 'path', 'change', 'size_bytes', 'previous_size_bytes', 'detected_at'],
        changes.map((change) => [
          change.rootId,
          change.relPath,
          change.kind,
          change.sizeBytes ?? '',
          change.previousSizeBytes ?? '',
          change.detectedAt,
        ]),
      ),
    );
  });

  /* ------------------------------------------------------------ storage view */

  /**
   * Treemap data for the WizTree-style view. Rectangles are laid out server-side so
   * the browser never has to hold a directory with 40k children.
   */
  app.get('/api/storage/treemap', async (request, reply) => {
    const query = parseQuery(
      z.object({
        rootId: z.string().min(1),
        path: z.string().default(''),
        width: intParam(1200, 8000),
        height: intParam(700, 8000),
        depth: intParam(2, 5),
        /** `effective` accounts for DrivePool duplication; `logical` ignores it. */
        metric: z.enum(['effective', 'logical']).default('effective'),
      }),
      request,
      reply,
    );
    if (!query) return reply;

    const useEffective = query.metric === 'effective';
    const build = (relPath: string, depth: number): TreemapInput[] => {
      const { entries } = catalog.listDirectory(query.rootId, relPath, { limit: 5000 });
      const nodes: TreemapInput[] = entries
        .map((entry) => ({
          id: `${query.rootId}:${entry.relPath}`,
          name: entry.name,
          value: useEffective ? entry.effectiveBytes : entry.sizeBytes,
          kind: entry.kind,
          meta: {
            relPath: entry.relPath,
            fileCount: entry.fileCount,
            sizeBytes: entry.sizeBytes,
            effectiveBytes: entry.effectiveBytes,
            duplicationLevel: entry.duplicationLevel,
          },
        }))
        .filter((node) => node.value > 0);

      const collapsed = collapseSmall(nodes, { maxNodes: 80, minShare: 0.0015 });
      if (depth <= 0) return collapsed;
      return collapsed.map((node) => {
        const meta = node.meta as { relPath?: string } | undefined;
        if (node.kind !== 'directory' || !meta?.relPath) return node;
        return { ...node, children: build(meta.relPath, depth - 1) };
      });
    };

    const children = build(normalizeRelPath(query.path), query.depth);
    const nodes = layoutTreemap(
      { id: 'root', name: query.path || '/', value: 0, children },
      {
        width: query.width,
        height: query.height,
        maxDepth: query.depth,
        padding: 2,
        headerHeight: 16,
        minSubdivideSize: 60,
      },
    );
    const stats = catalog.rootStats(query.rootId);
    return {
      rootId: query.rootId,
      path: normalizeRelPath(query.path),
      metric: query.metric,
      totalBytes: useEffective ? stats.effectiveBytes : stats.bytes,
      nodes,
    };
  });

  /* ---------------------------------------------------------------- bit rot */

  app.get('/api/bitrot', async (request, reply) => {
    const query = parseQuery(
      z.object({
        status: z.enum(['open', 'confirmed', 'dismissed', 'resolved', 'active', 'any']).default('active'),
        rootId: z.string().optional(),
        search: z.string().optional(),
        limit: intParam(200, 2000),
        offset: intParam(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;
    return { ...bitrot.list(query), counts: bitrot.counts() };
  });

  app.post('/api/bitrot/status', async (request, reply) => {
    const body = parseBody(
      z.object({
        ids: z.array(z.number().int()).min(1),
        status: z.enum(['open', 'confirmed', 'dismissed', 'resolved']),
        note: z.string().max(1000).optional(),
      }),
      request,
      reply,
    );
    if (!body) return reply;
    const changed = bitrot.bulkSetStatus(body.ids, body.status, body.note);
    bitrot.syncAlert();
    return { changed, counts: bitrot.counts() };
  });

  app.get('/api/bitrot.csv', async (_request, reply) => {
    const { findings } = bitrot.list({ status: 'any', limit: 5000 });
    sendCsv(
      reply,
      'sakuradrive-bitrot.csv',
      toCsv(
        ['root', 'path', 'size_bytes', 'expected_hash', 'actual_hash', 'algorithm', 'detected_at', 'status', 'note'],
        findings.map((finding) => [
          finding.rootId,
          finding.relPath,
          finding.sizeBytes,
          finding.expectedHash,
          finding.actualHash,
          finding.hashAlgorithm,
          finding.detectedAt,
          finding.status,
          finding.note,
        ]),
      ),
    );
  });

  /* ------------------------------------------------------- disaster recovery */

  /**
   * What is lost if a given disk dies. Precise when the disk's `PoolPart.*` folder is
   * catalogued as its own root; otherwise it falls back to the duplication rules and
   * says so in the response.
   */
  app.get('/api/dr/impact', async (request, reply) => {
    const query = parseQuery(
      z.object({
        rootId: z.string().min(1),
        limit: intParam(500, 5000),
        offset: intParam(0),
      }),
      request,
      reply,
    );
    if (!query) return reply;

    const config = settings.get();
    const root = config.catalog.roots.find((candidate) => candidate.id === query.rootId);
    if (!root) return reply.code(404).send({ error: 'not_found', message: 'Unknown catalog root' });

    const siblings = config.catalog.roots.filter(
      (candidate) =>
        candidate.id !== root.id &&
        candidate.kind === 'poolpart' &&
        candidate.poolId !== null &&
        candidate.poolId === root.poolId,
    );

    const backupRules = config.backup.expectations.filter(
      (expectation) => expectation.enabled && expectation.rootId === root.id,
    );

    return {
      impact: catalog.diskLossImpact(query.rootId),
      /** False means the numbers come from duplication rules, not observed copies. */
      precise: siblings.length > 0,
      siblingRoots: siblings.map((sibling) => ({ id: sibling.id, name: sibling.name })),
      backupExpectations: backupRules.map((rule) => ({ id: rule.id, name: rule.name })),
      files: catalog.listUnrecoverableFiles(query.rootId, query.limit, query.offset),
    };
  });

  app.get('/api/dr/impact.csv', async (request, reply) => {
    const query = parseQuery(z.object({ rootId: z.string().min(1) }), request, reply);
    if (!query) return reply;
    const { files } = catalog.listUnrecoverableFiles(query.rootId, 100_000, 0);
    sendCsv(
      reply,
      `sakuradrive-dr-${query.rootId}.csv`,
      toCsv(
        ['path', 'size_bytes', 'modified'],
        files.map((file) => [file.relPath, file.sizeBytes, new Date(file.mtimeMs).toISOString()]),
      ),
    );
  });

  /**
   * Files with no surviving copy anywhere in the pool.
   *
   * A file deleted from one disk but still present on another has not been lost. This
   * is the list that matters after a disk dies, and it is why the pool is a view over
   * its members rather than a separately scanned tree.
   */
  app.get('/api/dr/pool-missing', async (request, reply) => {
    const query = parseQuery(
      z.object({ poolId: z.string().min(1), limit: intParam(500, 5000), offset: intParam(0) }),
      request,
      reply,
    );
    if (!query) return reply;
    return catalog.poolMissingFiles(query.poolId, query.limit, query.offset);
  });

  app.get('/api/dr/pool-missing.csv', async (request, reply) => {
    const query = parseQuery(z.object({ poolId: z.string().min(1) }), request, reply);
    if (!query) return reply;
    const { files } = catalog.poolMissingFiles(query.poolId, 100_000, 0);
    sendCsv(
      reply,
      `sakuradrive-pool-missing-${query.poolId}.csv`,
      toCsv(
        ['path', 'size_bytes', 'deleted_at'],
        files.map((file) => [file.relPath, file.sizeBytes, file.deletedAt ?? '']),
      ),
    );
  });

  app.get('/api/dr/under-duplicated', async (request, reply) => {
    const query = parseQuery(
      z.object({ poolId: z.string().min(1), limit: intParam(500, 5000) }),
      request,
      reply,
    );
    if (!query) return reply;
    const files = catalog.findUnderDuplicated(query.poolId, query.limit);
    return {
      files,
      totalBytes: files.reduce(
        (sum, file) => sum + effectiveSize(file.sizeBytes, file.expectedLevel - file.observedLevel),
        0,
      ),
    };
  });
}
