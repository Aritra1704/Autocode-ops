import { config } from '../config.js';
import { getPool } from '../db/client.js';

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return null;
  }

  const dimensions = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);

    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      continue;
    }

    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function extractQueryTerms(text) {
  return [...new Set(
    `${text ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]+/g, ' ')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3)
  )].slice(0, 6);
}

export function createRagRetriever(options = {}) {
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
    async retrieveRelevantDocumentChunks(queryText, input = {}) {
      const text = `${queryText ?? ''}`.trim();
      if (!text) {
        return [];
      }

      const candidateLimit = input.candidateLimit ?? 250;
      const topK = input.topK ?? 4;
      const minimumScore = input.minimumScore ?? 0.08;
      const keywordFallback = async () => {
        const terms = extractQueryTerms(text);
        if (terms.length === 0) {
          return [];
        }

        const patterns = terms.map((term) => `%${term}%`);
        const rows = await callPostgresTool(
          'search_document_chunks',
          {
            keywords: terms,
            limit: topK,
          },
          () =>
            pool.query(
              `SELECT
                 LEFT(document_chunks.content, 320) AS content,
                 documents.title,
                 documents.source_path
               FROM document_chunks
               JOIN documents ON documents.id = document_chunks.document_id
               WHERE document_chunks.content ILIKE ANY($1::text[])
               ORDER BY document_chunks.created_at DESC
               LIMIT $2`,
              [patterns, topK]
            )
        );

        return rows.rows;
      };

      if (!embeddingClient?.embed) {
        return keywordFallback();
      }

      try {
        const embedded = await embeddingClient.embed({
          model: embedModel,
          input: text,
        });

        const candidates = await callPostgresTool(
          'list_embedding_candidates',
          {
            modelTag: embedModel,
            limit: candidateLimit,
          },
          () =>
            pool.query(
              `SELECT
                 LEFT(document_chunks.content, 320) AS content,
                 documents.title,
                 documents.source_path,
                 embeddings_index.embedding
               FROM embeddings_index
               JOIN document_chunks
                 ON document_chunks.id = embeddings_index.document_chunk_id
               JOIN documents
                 ON documents.id = document_chunks.document_id
               WHERE embeddings_index.model_tag = $1
               ORDER BY document_chunks.created_at DESC
               LIMIT $2`,
              [embedModel, candidateLimit]
            )
        );

        const scored = candidates.rows
          .map((row) => ({
            content: row.content,
            title: row.title,
            source_path: row.source_path,
            score: cosineSimilarity(embedded.embedding, row.embedding),
          }))
          .sort((left, right) => right.score - left.score)
          .filter((row) => Number.isFinite(row.score));

        const filtered = scored.filter((row) => row.score >= minimumScore);
        if (filtered.length > 0) {
          return filtered.slice(0, topK);
        }

        return scored.slice(0, topK);
      } catch (error) {
        logger?.warn({ err: error }, 'Failed semantic document retrieval');
        return keywordFallback();
      }
    },
  };
}
