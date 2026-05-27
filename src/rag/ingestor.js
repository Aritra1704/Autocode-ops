import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { getPool } from '../db/client.js';
import { chunkDocumentText } from './chunker.js';

const DOC_FILE_EXTENSIONS = new Set(['.md', '.txt', '.mdx']);
const DOC_IGNORE_SEGMENTS = new Set(['node_modules', '.git', '.opskit', 'workspace', 'logs']);
const DEFAULT_ROOT_FILES = [
  'README.md',
  'PROJECT_CONTEXT.md',
  'PROJECT_RULES.md',
  'PROJECT_CONTEXT.local.md',
];

function createChecksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function deriveTitle(relativePath, content) {
  const heading = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));

  if (heading) {
    return heading.slice(2).trim().slice(0, 160) || relativePath;
  }

  return path.basename(relativePath).slice(0, 160);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkDocs(dirPath, projectRoot, results) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    const relativePath = normalizeRelativePath(path.relative(projectRoot, absolutePath));
    const segments = relativePath.split('/').filter(Boolean);

    if (segments.some((segment) => DOC_IGNORE_SEGMENTS.has(segment))) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDocs(absolutePath, projectRoot, results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!DOC_FILE_EXTENSIONS.has(extension)) {
      continue;
    }

    results.add(relativePath);
  }
}

async function collectDocumentPaths(projectRoot) {
  const results = new Set();

  for (const relativePath of DEFAULT_ROOT_FILES) {
    const absolutePath = path.join(projectRoot, relativePath);
    if (await pathExists(absolutePath)) {
      results.add(normalizeRelativePath(relativePath));
    }
  }

  const docsDir = path.join(projectRoot, 'docs');
  if (await pathExists(docsDir)) {
    await walkDocs(docsDir, projectRoot, results);
  }

  return [...results].sort();
}

export function createRagIngestor(options = {}) {
  const pool = options.pool ?? getPool();
  const embeddingClient = options.embeddingClient;
  const logger = options.logger;
  const embedModel = options.embedModel ?? config.modelEmbed;
  const mcpRegistry = options.mcpRegistry ?? null;
  const postgresServer = mcpRegistry?.getServer?.('postgres') ?? null;

  async function callPostgresTool(toolName, args, fallback) {
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }
    return fallback();
  }

  return {
    async ingestProjectDocuments(input = {}) {
      const projectRoot = input.projectRoot ?? process.cwd();
      const sourcePaths = await collectDocumentPaths(projectRoot);
      const summary = {
        scanned: sourcePaths.length,
        indexed: 0,
        skippedUnchanged: 0,
        chunksUpserted: 0,
        embeddingsUpserted: 0,
        embeddingErrors: 0,
      };

      for (const relativePath of sourcePaths) {
        const absolutePath = path.join(projectRoot, relativePath);
        const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
        const normalizedContent = content.trim();

        if (normalizedContent.length < 40) {
          continue;
        }

        const checksum = createChecksum(normalizedContent);
        const title = deriveTitle(relativePath, normalizedContent);

        const existingResult = await callPostgresTool(
          'get_document_by_source_path',
          {
            sourcePath: relativePath,
          },
          () =>
            pool.query(
              `SELECT id, checksum
               FROM documents
               WHERE source_path = $1
               LIMIT 1`,
              [relativePath]
            )
        );

        const existing = existingResult.rows[0] ?? null;
        if (existing && existing.checksum === checksum) {
          summary.skippedUnchanged += 1;
          continue;
        }

        let documentId = existing?.id ?? null;
        const upsertedDocument = await callPostgresTool(
          'upsert_document_record',
          {
            id: documentId,
            sourceType: 'project_doc',
            sourcePath: relativePath,
            title,
            checksum,
          },
          () =>
            !documentId
              ? pool.query(
                  `INSERT INTO documents (source_type, source_path, title, checksum)
                   VALUES ('project_doc', $1, $2, $3)
                   RETURNING id`,
                  [relativePath, title, checksum]
                )
              : pool.query(
                  `UPDATE documents
                   SET title = $2, checksum = $3
                   WHERE id = $1
                   RETURNING id`,
                  [documentId, title, checksum]
                )
        );
        documentId = upsertedDocument.rows[0].id;

        await callPostgresTool(
          'delete_document_embeddings_by_document',
          { documentId },
          () =>
            pool.query(
              `DELETE FROM embeddings_index
               WHERE document_chunk_id IN (
                 SELECT id FROM document_chunks WHERE document_id = $1
               )`,
              [documentId]
            )
        );
        await callPostgresTool(
          'delete_document_chunks_by_document',
          { documentId },
          () => pool.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId])
        );

        const chunks = chunkDocumentText(normalizedContent);
        for (const chunk of chunks) {
          const insertedChunk = await callPostgresTool(
            'insert_document_chunk',
            {
              documentId,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
              tokenEstimate: chunk.tokenEstimate,
            },
            () =>
              pool.query(
                `INSERT INTO document_chunks (document_id, chunk_index, content, token_estimate)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id`,
                [documentId, chunk.chunkIndex, chunk.content, chunk.tokenEstimate]
              )
          );
          summary.chunksUpserted += 1;

          if (!embeddingClient?.embed) {
            continue;
          }

          try {
            const embedded = await embeddingClient.embed({
              model: embedModel,
              input: chunk.content,
            });

            await callPostgresTool(
              'upsert_chunk_embedding',
              {
                documentChunkId: insertedChunk.rows[0].id,
                modelTag: embedModel,
                embedding: embedded.embedding,
              },
              () =>
                pool.query(
                  `INSERT INTO embeddings_index (document_chunk_id, model_tag, embedding)
                   VALUES ($1, $2, $3::jsonb)
                   ON CONFLICT (document_chunk_id, model_tag)
                   DO UPDATE SET embedding = EXCLUDED.embedding, created_at = NOW()`,
                  [insertedChunk.rows[0].id, embedModel, JSON.stringify(embedded.embedding)]
                )
            );

            summary.embeddingsUpserted += 1;
          } catch (error) {
            summary.embeddingErrors += 1;
            logger?.warn(
              { err: error, sourcePath: relativePath, chunkIndex: chunk.chunkIndex },
              'Failed to embed document chunk'
            );
          }
        }

        summary.indexed += 1;
      }

      return summary;
    },
  };
}
