import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services/container.js';
import { errorMessage, parseBody, parseQuery } from './helpers.js';

export function registerExportRoutes(app: FastifyInstance, services: Services): void {
  const { exports, settings, workflows, config } = services;

  /** Build a bundle on demand and leave it in the data directory for download. */
  app.post('/api/export/create', async (request, reply) => {
    const body = parseBody(
      z
        .object({
          includeCatalog: z.boolean().default(true),
          includeHistory: z.boolean().default(true),
          includeSmartHistory: z.boolean().default(true),
          includePerformanceHistory: z.boolean().default(false),
          redactSecrets: z.boolean().optional(),
        })
        .partial(),
      request,
      reply,
    );
    if (!body) return reply;

    try {
      const result = await exports.export(undefined, { ...body, trigger: 'manual' });
      exports.recordExport({
        fileName: result.fileName,
        destinationId: null,
        destinationPath: result.filePath,
        sizeBytes: result.sizeBytes,
        recordCount: result.recordCount,
        checksum: result.checksum,
        trigger: 'manual',
        verified: false,
      });
      return {
        fileName: result.fileName,
        sizeBytes: result.sizeBytes,
        recordCount: result.recordCount,
        checksum: result.checksum,
        downloadUrl: `/api/export/download?file=${encodeURIComponent(result.fileName)}`,
      };
    } catch (error) {
      return reply.code(500).send({ error: 'export_failed', message: errorMessage(error) });
    }
  });

  app.get('/api/export/download', async (request, reply) => {
    const query = parseQuery(z.object({ file: z.string().min(1) }), request, reply);
    if (!query) return reply;

    // Only ever serve from the export directory, and only a plain file name: the
    // parameter comes from a URL, so a traversal attempt must not escape.
    const fileName = path.basename(query.file);
    const filePath = path.join(exports.exportDir, fileName);
    if (!filePath.startsWith(exports.exportDir) || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'not_found', message: 'No such export bundle' });
    }
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .send(fs.createReadStream(filePath));
  });

  /** Run the scheduled export workflow immediately, writing to every destination. */
  app.post('/api/export/run-now', async (_request, reply) => {
    try {
      const run = await workflows.start('export.backup', { trigger: 'manual', force: true });
      return { run };
    } catch (error) {
      return reply.code(409).send({ error: 'cannot_start', message: errorMessage(error) });
    }
  });

  /**
   * Import a bundle. Accepts a multipart upload from the browser, or a path to a file
   * already inside the container (a bundle restored from Backblaze, say).
   */
  app.post('/api/export/import', async (request, reply) => {
    const query = parseQuery(
      z.object({
        mode: z.enum(['merge', 'replace']).default('merge'),
        importSettings: z.coerce.boolean().default(false),
        path: z.string().optional(),
      }),
      request,
      reply,
    );
    if (!query) return reply;

    let sourcePath: string;
    let temporary = false;

    if (query.path) {
      if (!fs.existsSync(query.path)) {
        return reply.code(404).send({ error: 'not_found', message: `No such file: ${query.path}` });
      }
      sourcePath = query.path;
    } else {
      const upload = await request.file();
      if (!upload) {
        return reply
          .code(400)
          .send({ error: 'no_file', message: 'Attach a bundle, or pass ?path= for a file in the container' });
      }
      fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
      sourcePath = path.join(config.dataDir, 'tmp', `import-${Date.now()}-${path.basename(upload.filename)}`);
      await pipeline(upload.file, fs.createWriteStream(sourcePath));
      temporary = true;
    }

    try {
      const result = await exports.import(sourcePath, {
        mode: query.mode,
        importSettings: query.importSettings,
      });
      services.logger.info(
        { imported: result.imported, mode: query.mode },
        'imported an export bundle',
      );
      return result;
    } catch (error) {
      return reply.code(400).send({ error: 'import_failed', message: errorMessage(error) });
    } finally {
      if (temporary) fs.rmSync(sourcePath, { force: true });
    }
  });

  /** Read a bundle's manifest so the UI can show what an import would bring in. */
  app.post('/api/export/inspect', async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'no_file', message: 'Attach a bundle' });
    fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
    const temp = path.join(config.dataDir, 'tmp', `inspect-${Date.now()}`);
    try {
      await pipeline(upload.file, fs.createWriteStream(temp));
      const manifest = await exports.inspect(temp);
      if (!manifest) {
        return reply
          .code(400)
          .send({ error: 'not_a_bundle', message: 'That file is not a SakuraDrive export bundle' });
      }
      return { manifest };
    } finally {
      fs.rmSync(temp, { force: true });
    }
  });

  app.get('/api/export/destinations/check', async (_request) => {
    const destinations = settings.get().autoExport.destinations;
    return {
      destinations: destinations.map((destination) => {
        let writable = false;
        let error: string | null = null;
        try {
          fs.mkdirSync(destination.path, { recursive: true });
          fs.accessSync(destination.path, fs.constants.W_OK);
          writable = true;
        } catch (caught) {
          error = errorMessage(caught);
        }
        return { id: destination.id, name: destination.name, path: destination.path, writable, error };
      }),
    };
  });
}
