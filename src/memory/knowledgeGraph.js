import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { getPool } from '../db/client.js';
import { createGraphifyAdapter } from './graphifyAdapter.js';

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const GRAPH_IGNORE_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'logs',
  'workspace',
  'dist',
  'coverage',
  'tmp',
]);

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function isGraphRelevantFile(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext);
}

function nodeTypeForPath(relativePath) {
  return DOC_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) ? 'document' : 'file';
}

function extractKeywords(text, limit = 8) {
  return [...new Set(
    `${text ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9_/\s.-]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  )].slice(0, limit);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkProjectFiles(dirPath, projectRoot, results) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    const relativePath = normalizeRelativePath(path.relative(projectRoot, absolutePath));
    const segments = relativePath.split('/').filter(Boolean);

    if (segments.some((segment) => GRAPH_IGNORE_SEGMENTS.has(segment))) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkProjectFiles(absolutePath, projectRoot, results);
      continue;
    }

    if (!entry.isFile() || !isGraphRelevantFile(relativePath)) {
      continue;
    }

    results.add(relativePath);
  }
}

async function collectProjectPaths(projectRoot) {
  const results = new Set();
  await walkProjectFiles(projectRoot, projectRoot, results);
  return [...results].sort();
}

function parseSymbols(content) {
  const symbols = [];
  const pushSymbol = (name, symbolKind, exported = false) => {
    if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      return;
    }

    if (symbols.some((symbol) => symbol.name === name && symbol.kind === symbolKind)) {
      return;
    }

    symbols.push({ name, kind: symbolKind, exported });
  };

  for (const match of content.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    pushSymbol(match[1], 'function', true);
  }
  for (const match of content.matchAll(/\bexport\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    pushSymbol(match[1], 'class', true);
  }
  for (const match of content.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    pushSymbol(match[1], 'variable', true);
  }
  for (const match of content.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    pushSymbol(match[1], 'function', false);
  }
  for (const match of content.matchAll(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    pushSymbol(match[1], 'class', false);
  }

  return symbols.slice(0, 80);
}

function parseImports(content) {
  const imports = [];
  const seen = new Set();
  const patterns = [
    /\bimport\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (!specifier || seen.has(specifier)) {
        continue;
      }
      seen.add(specifier);
      imports.push(specifier);
    }
  }

  return imports;
}

function parseMarkdownLinks(content) {
  const links = [];
  const seen = new Set();
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const specifier = match[1]?.trim();
    if (!specifier || specifier.startsWith('http://') || specifier.startsWith('https://')) {
      continue;
    }
    if (seen.has(specifier)) {
      continue;
    }
    seen.add(specifier);
    links.push(specifier);
  }
  return links;
}

function normalizeDependencyName(specifier) {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

function resolveReferencePath(specifier, sourcePath, knownPaths) {
  if (!specifier || (!specifier.startsWith('.') && !specifier.startsWith('/'))) {
    return null;
  }

  const sourceDir = path.posix.dirname(sourcePath);
  const normalizedBase = normalizeRelativePath(
    path.posix.normalize(
      specifier.startsWith('/')
        ? specifier.slice(1)
        : path.posix.join(sourceDir, specifier)
    )
  );

  const candidates = [
    normalizedBase,
    `${normalizedBase}.js`,
    `${normalizedBase}.jsx`,
    `${normalizedBase}.ts`,
    `${normalizedBase}.tsx`,
    `${normalizedBase}.mjs`,
    `${normalizedBase}.cjs`,
    `${normalizedBase}.md`,
    `${normalizedBase}.mdx`,
    path.posix.join(normalizedBase, 'index.js'),
    path.posix.join(normalizedBase, 'index.jsx'),
    path.posix.join(normalizedBase, 'index.ts'),
    path.posix.join(normalizedBase, 'index.tsx'),
    path.posix.join(normalizedBase, 'index.mjs'),
    path.posix.join(normalizedBase, 'index.cjs'),
    path.posix.join(normalizedBase, 'README.md'),
  ];

  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) {
      return candidate;
    }
  }

  return normalizedBase;
}

function formatGraphContext(graphContext) {
  if (!graphContext) {
    return [];
  }

  const lines = [];

  if (Array.isArray(graphContext.matches) && graphContext.matches.length > 0) {
    lines.push('Architecture graph:');
    for (const match of graphContext.matches) {
      const source = match.source_path ? ` @ ${match.source_path}` : '';
      lines.push(`- [${match.node_type}] ${match.display_name}${source}`);
    }
  }

  if (Array.isArray(graphContext.relationships) && graphContext.relationships.length > 0) {
    lines.push('Impact relationships:');
    for (const relation of graphContext.relationships) {
      lines.push(`- ${relation.from_name} -[${relation.edge_type}]-> ${relation.to_name}`);
    }
  }

  if (Array.isArray(graphContext.recentChanges) && graphContext.recentChanges.length > 0) {
    lines.push('Historical changes:');
    for (const change of graphContext.recentChanges) {
      const touchedPath = change.relative_path ? ` @ ${change.relative_path}` : '';
      lines.push(`- ${change.title} (${change.status})${touchedPath}`);
    }
  }

  if (Array.isArray(graphContext.relatedLearnings) && graphContext.relatedLearnings.length > 0) {
    lines.push('Historical learnings:');
    for (const learning of graphContext.relatedLearnings) {
      lines.push(
        `- [${learning.category}] ${learning.observation} (confidence=${learning.confidence_score})`
      );
    }
  }

  return lines;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function summarizeNodes(nodes = []) {
  return uniqueStrings(nodes.map((node) => node.source_path || node.display_name)).slice(0, 4);
}

function buildImpactAnalysis(queryText, graphContext) {
  if (!graphContext) {
    return null;
  }

  const primaryTargets = summarizeNodes(graphContext.matches);
  const upstreamDependencies = uniqueStrings(
    (graphContext.relationships ?? [])
      .filter((relation) => relation.edge_type === 'imports' || relation.edge_type === 'depends_on')
      .map((relation) => relation.to_path || relation.to_name)
  ).slice(0, 5);
  const downstreamDependents = uniqueStrings(
    (graphContext.relationships ?? [])
      .filter((relation) => relation.edge_type === 'imports' || relation.edge_type === 'references')
      .map((relation) => relation.from_path || relation.from_name)
  ).filter((entry) => !primaryTargets.includes(entry)).slice(0, 5);
  const volatileAreas = uniqueStrings(
    (graphContext.recentChanges ?? []).map((change) => change.relative_path)
  ).slice(0, 4);
  const historicalLearnings = uniqueStrings(
    (graphContext.relatedLearnings ?? []).map((learning) => learning.observation)
  ).slice(0, 3);

  const signalCount =
    primaryTargets.length +
    upstreamDependencies.length +
    downstreamDependents.length +
    volatileAreas.length +
    historicalLearnings.length;
  const riskLevel = signalCount >= 10 ? 'high' : signalCount >= 5 ? 'medium' : 'low';

  const summaryParts = [];
  if (primaryTargets.length > 0) {
    summaryParts.push(`touches ${primaryTargets.join(', ')}`);
  }
  if (upstreamDependencies.length > 0) {
    summaryParts.push(`depends on ${upstreamDependencies.join(', ')}`);
  }
  if (downstreamDependents.length > 0) {
    summaryParts.push(`affects ${downstreamDependents.join(', ')}`);
  }

  const lines = ['Semantic impact analysis:'];
  if (primaryTargets.length > 0) {
    lines.push(`- likely edit targets: ${primaryTargets.join(', ')}`);
  }
  if (upstreamDependencies.length > 0) {
    lines.push(`- upstream dependencies: ${upstreamDependencies.join(', ')}`);
  }
  if (downstreamDependents.length > 0) {
    lines.push(`- downstream dependents: ${downstreamDependents.join(', ')}`);
  }
  if (volatileAreas.length > 0) {
    lines.push(`- recently changed areas: ${volatileAreas.join(', ')}`);
  }
  if (historicalLearnings.length > 0) {
    lines.push(`- historical cautions: ${historicalLearnings.join(' | ')}`);
  }
  lines.push(`- impact risk: ${riskLevel}`);

  return {
    queryText,
    summary:
      summaryParts.length > 0
        ? `Impact analysis ${summaryParts.join('; ')}.`
        : 'Impact analysis found only limited graph evidence.',
    riskLevel,
    primaryTargets,
    upstreamDependencies,
    downstreamDependents,
    volatileAreas,
    historicalLearnings,
    lines,
  };
}

export function createKnowledgeGraphService(options = {}) {
  const pool = options.pool ?? getPool();
  const logger = options.logger ?? null;
  const mcpRegistry = options.mcpRegistry ?? null;
  const postgresServer = mcpRegistry?.getServer?.('postgres') ?? null;
  const graphifyAdapter =
    config.graphBackend === 'graphify'
      ? createGraphifyAdapter({
          logger,
          indexPath: options.graphifyIndexPath ?? config.graphifyIndexPath,
        })
      : null;

  async function callPostgresTool(toolName, args, fallback) {
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }
    return fallback();
  }

  async function upsertGraphNode(node) {
    return callPostgresTool(
      'upsert_graph_node',
      node,
      () =>
        pool.query(
          `INSERT INTO knowledge_graph_nodes (
             node_key,
             node_type,
             display_name,
             source_path,
             checksum,
             metadata,
             updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
           ON CONFLICT (node_key)
           DO UPDATE SET
             node_type = EXCLUDED.node_type,
             display_name = EXCLUDED.display_name,
             source_path = COALESCE(EXCLUDED.source_path, knowledge_graph_nodes.source_path),
             checksum = EXCLUDED.checksum,
             metadata = EXCLUDED.metadata,
             updated_at = NOW()
           RETURNING id`,
          [
            node.nodeKey,
            node.nodeType,
            node.displayName,
            node.sourcePath ?? null,
            node.checksum ?? null,
            JSON.stringify(node.metadata ?? {}),
          ]
        )
    );
  }

  async function upsertGraphEdge(edge) {
    return callPostgresTool(
      'upsert_graph_edge',
      edge,
      () =>
        pool.query(
          `INSERT INTO knowledge_graph_edges (
             from_node_id,
             to_node_id,
             edge_type,
             metadata,
             updated_at
           )
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (from_node_id, to_node_id, edge_type)
           DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()`,
          [
            edge.fromNodeId,
            edge.toNodeId,
            edge.edgeType,
            JSON.stringify(edge.metadata ?? {}),
          ]
        )
    );
  }

  async function persistNormalizedGraph(graph) {
    const summary = {
      scanned: graph.nodes.length,
      nodesUpserted: 0,
      edgesUpserted: 0,
      source: graph.source ?? 'graphify',
    };
    const nodeIdsByKey = new Map();
    const sourcePaths = [...new Set(graph.nodes.map((node) => node.sourcePath).filter(Boolean))];

    for (const sourcePath of sourcePaths) {
      await callPostgresTool(
        'delete_graph_nodes_by_source_path',
        {
          sourcePath,
          nodeTypes: ['symbol'],
        },
        () =>
          pool.query(
            `DELETE FROM knowledge_graph_nodes
             WHERE source_path = $1
               AND node_type = ANY($2::text[])`,
            [sourcePath, ['symbol']]
          )
      );
    }

    for (const node of graph.nodes) {
      const result = await upsertGraphNode(node);
      nodeIdsByKey.set(node.nodeKey, result.rows[0].id);
      summary.nodesUpserted += 1;

      if (node.nodeType === 'file' || node.nodeType === 'document') {
        await callPostgresTool(
          'delete_graph_edges_from_node',
          { nodeId: result.rows[0].id },
          () => pool.query(`DELETE FROM knowledge_graph_edges WHERE from_node_id = $1`, [result.rows[0].id])
        );
      }
    }

    for (const edge of graph.edges) {
      const fromNodeId = nodeIdsByKey.get(edge.fromNodeKey);
      const toNodeId = nodeIdsByKey.get(edge.toNodeKey);

      if (!fromNodeId || !toNodeId) {
        continue;
      }

      await upsertGraphEdge({
        fromNodeId,
        toNodeId,
        edgeType: edge.edgeType,
        metadata: edge.metadata ?? {},
      });
      summary.edgesUpserted += 1;
    }

    logger?.info(
      {
        graphSummary: summary,
        graphifySourcePath: graph.sourcePath ?? null,
      },
      'Knowledge graph sync completed via Graphify adapter'
    );

    return summary;
  }

  return {
    async ingestProjectGraph(input = {}) {
      const projectRoot = input.projectRoot ?? process.cwd();
      if (graphifyAdapter) {
        try {
          const graphifyGraph = await graphifyAdapter.loadNormalizedGraph({ projectRoot });
          if (graphifyGraph) {
            return persistNormalizedGraph(graphifyGraph);
          }
        } catch (error) {
          logger?.warn(
            { err: error, projectRoot },
            'Graphify-backed indexing failed; falling back to native graph ingestion'
          );
        }
      }

      const sourcePaths = await collectProjectPaths(projectRoot);
      const knownPaths = new Set(sourcePaths);
      const summary = {
        scanned: sourcePaths.length,
        nodesUpserted: 0,
        edgesUpserted: 0,
      };

      for (const relativePath of sourcePaths) {
        const absolutePath = path.join(projectRoot, relativePath);
        if (!(await pathExists(absolutePath))) {
          continue;
        }

        const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
        const fileNode = await callPostgresTool(
          'upsert_graph_node',
          {
            nodeKey: `${nodeTypeForPath(relativePath)}:${relativePath}`,
            nodeType: nodeTypeForPath(relativePath),
            displayName: path.basename(relativePath),
            sourcePath: relativePath,
            checksum: content.length > 0 ? `${content.length}:${content.slice(0, 32)}` : null,
            metadata: {
              relativePath,
              extension: path.extname(relativePath).toLowerCase(),
            },
          },
          () =>
            pool.query(
              `INSERT INTO knowledge_graph_nodes (
                 node_key,
                 node_type,
                 display_name,
                 source_path,
                 checksum,
                 metadata,
                 updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
               ON CONFLICT (node_key)
               DO UPDATE SET
                 node_type = EXCLUDED.node_type,
                 display_name = EXCLUDED.display_name,
                 source_path = EXCLUDED.source_path,
                 checksum = EXCLUDED.checksum,
                 metadata = EXCLUDED.metadata,
                 updated_at = NOW()
               RETURNING id`,
              [
                `${nodeTypeForPath(relativePath)}:${relativePath}`,
                nodeTypeForPath(relativePath),
                path.basename(relativePath),
                relativePath,
                content.length > 0 ? `${content.length}:${content.slice(0, 32)}` : null,
                JSON.stringify({
                  relativePath,
                  extension: path.extname(relativePath).toLowerCase(),
                }),
              ]
            )
        );
        summary.nodesUpserted += 1;

        await callPostgresTool(
          'delete_graph_edges_from_node',
          { nodeId: fileNode.rows[0].id },
          () =>
            pool.query(
              `DELETE FROM knowledge_graph_edges WHERE from_node_id = $1`,
              [fileNode.rows[0].id]
            )
        );

        if (CODE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
          await callPostgresTool(
            'delete_graph_nodes_by_source_path',
            {
              sourcePath: relativePath,
              nodeTypes: ['symbol'],
            },
            () =>
              pool.query(
                `DELETE FROM knowledge_graph_nodes
                 WHERE source_path = $1
                   AND node_type = ANY($2::text[])`,
                [relativePath, ['symbol']]
              )
          );

          for (const symbol of parseSymbols(content)) {
            const symbolNode = await callPostgresTool(
              'upsert_graph_node',
              {
                nodeKey: `symbol:${relativePath}:${symbol.name}`,
                nodeType: 'symbol',
                displayName: symbol.name,
                sourcePath: relativePath,
                metadata: {
                  kind: symbol.kind,
                  exported: symbol.exported,
                },
              },
              () =>
                pool.query(
                  `INSERT INTO knowledge_graph_nodes (
                     node_key,
                     node_type,
                     display_name,
                     source_path,
                     metadata,
                     updated_at
                   )
                   VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                   ON CONFLICT (node_key)
                   DO UPDATE SET
                     display_name = EXCLUDED.display_name,
                     source_path = EXCLUDED.source_path,
                     metadata = EXCLUDED.metadata,
                     updated_at = NOW()
                   RETURNING id`,
                  [
                    `symbol:${relativePath}:${symbol.name}`,
                    'symbol',
                    symbol.name,
                    relativePath,
                    JSON.stringify({
                      kind: symbol.kind,
                      exported: symbol.exported,
                    }),
                  ]
                )
            );
            summary.nodesUpserted += 1;

            await callPostgresTool(
              'upsert_graph_edge',
              {
                fromNodeId: fileNode.rows[0].id,
                toNodeId: symbolNode.rows[0].id,
                edgeType: 'contains',
                metadata: {
                  symbolKind: symbol.kind,
                  exported: symbol.exported,
                },
              },
              () =>
                pool.query(
                  `INSERT INTO knowledge_graph_edges (
                     from_node_id,
                     to_node_id,
                     edge_type,
                     metadata,
                     updated_at
                   )
                   VALUES ($1, $2, $3, $4::jsonb, NOW())
                   ON CONFLICT (from_node_id, to_node_id, edge_type)
                   DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()`,
                  [
                    fileNode.rows[0].id,
                    symbolNode.rows[0].id,
                    'contains',
                    JSON.stringify({
                      symbolKind: symbol.kind,
                      exported: symbol.exported,
                    }),
                  ]
                )
            );
            summary.edgesUpserted += 1;
          }

          for (const specifier of parseImports(content)) {
            let targetNodeArgs;
            let edgeType = 'imports';

            if (specifier.startsWith('.') || specifier.startsWith('/')) {
              const resolved = resolveReferencePath(specifier, relativePath, knownPaths);
              const targetType = resolved ? nodeTypeForPath(resolved) : 'file';
              targetNodeArgs = {
                nodeKey: `${targetType}:${resolved ?? specifier}`,
                nodeType: targetType,
                displayName: path.basename(resolved ?? specifier),
                sourcePath: resolved ?? null,
                metadata: {
                  specifier,
                  resolvedPath: resolved ?? null,
                },
              };
            } else {
              edgeType = 'depends_on';
              const dependencyName = normalizeDependencyName(specifier);
              targetNodeArgs = {
                nodeKey: `dependency:${dependencyName}`,
                nodeType: 'dependency',
                displayName: dependencyName,
                sourcePath: null,
                metadata: {
                  specifier,
                },
              };
            }

            const targetNode = await callPostgresTool(
              'upsert_graph_node',
              targetNodeArgs,
              () =>
                pool.query(
                  `INSERT INTO knowledge_graph_nodes (
                     node_key,
                     node_type,
                     display_name,
                     source_path,
                     metadata,
                     updated_at
                   )
                   VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                   ON CONFLICT (node_key)
                   DO UPDATE SET
                     node_type = EXCLUDED.node_type,
                     display_name = EXCLUDED.display_name,
                     source_path = COALESCE(EXCLUDED.source_path, knowledge_graph_nodes.source_path),
                     metadata = EXCLUDED.metadata,
                     updated_at = NOW()
                   RETURNING id`,
                  [
                    targetNodeArgs.nodeKey,
                    targetNodeArgs.nodeType,
                    targetNodeArgs.displayName,
                    targetNodeArgs.sourcePath,
                    JSON.stringify(targetNodeArgs.metadata ?? {}),
                  ]
                )
            );
            summary.nodesUpserted += 1;

            await callPostgresTool(
              'upsert_graph_edge',
              {
                fromNodeId: fileNode.rows[0].id,
                toNodeId: targetNode.rows[0].id,
                edgeType,
                metadata: {
                  specifier,
                },
              },
              () =>
                pool.query(
                  `INSERT INTO knowledge_graph_edges (
                     from_node_id,
                     to_node_id,
                     edge_type,
                     metadata,
                     updated_at
                   )
                   VALUES ($1, $2, $3, $4::jsonb, NOW())
                   ON CONFLICT (from_node_id, to_node_id, edge_type)
                   DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()`,
                  [
                    fileNode.rows[0].id,
                    targetNode.rows[0].id,
                    edgeType,
                    JSON.stringify({ specifier }),
                  ]
                )
            );
            summary.edgesUpserted += 1;
          }
        } else {
          for (const link of parseMarkdownLinks(content)) {
            const resolved = resolveReferencePath(link, relativePath, knownPaths);
            if (!resolved) {
              continue;
            }

            const targetNode = await callPostgresTool(
              'upsert_graph_node',
              {
                nodeKey: `${nodeTypeForPath(resolved)}:${resolved}`,
                nodeType: nodeTypeForPath(resolved),
                displayName: path.basename(resolved),
                sourcePath: resolved,
                metadata: {
                  linkedFrom: relativePath,
                },
              },
              () =>
                pool.query(
                  `INSERT INTO knowledge_graph_nodes (
                     node_key,
                     node_type,
                     display_name,
                     source_path,
                     metadata,
                     updated_at
                   )
                   VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                   ON CONFLICT (node_key)
                   DO UPDATE SET
                     node_type = EXCLUDED.node_type,
                     display_name = EXCLUDED.display_name,
                     source_path = EXCLUDED.source_path,
                     metadata = EXCLUDED.metadata,
                     updated_at = NOW()
                   RETURNING id`,
                  [
                    `${nodeTypeForPath(resolved)}:${resolved}`,
                    nodeTypeForPath(resolved),
                    path.basename(resolved),
                    resolved,
                    JSON.stringify({ linkedFrom: relativePath }),
                  ]
                )
            );
            summary.nodesUpserted += 1;

            await callPostgresTool(
              'upsert_graph_edge',
              {
                fromNodeId: fileNode.rows[0].id,
                toNodeId: targetNode.rows[0].id,
                edgeType: 'references',
                metadata: {
                  specifier: link,
                },
              },
              () =>
                pool.query(
                  `INSERT INTO knowledge_graph_edges (
                     from_node_id,
                     to_node_id,
                     edge_type,
                     metadata,
                     updated_at
                   )
                   VALUES ($1, $2, $3, $4::jsonb, NOW())
                   ON CONFLICT (from_node_id, to_node_id, edge_type)
                   DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()`,
                  [
                    fileNode.rows[0].id,
                    targetNode.rows[0].id,
                    'references',
                    JSON.stringify({ specifier: link }),
                  ]
                )
            );
            summary.edgesUpserted += 1;
          }
        }
      }

      logger?.info({ graphSummary: summary }, 'Knowledge graph sync completed');
      return summary;
    },

    async retrieveRelevantContext(queryText, options = {}) {
      const keywords = extractKeywords(queryText, options.keywordLimit ?? 8);
      if (keywords.length === 0) {
        return null;
      }

      const result = await callPostgresTool(
        'search_graph_context',
        {
          keywords,
          limit: options.limit ?? 6,
          relationshipLimit: options.relationshipLimit ?? 10,
          changeLimit: options.changeLimit ?? 5,
          learningLimit: options.learningLimit ?? 4,
        },
        async () => {
          const patterns = keywords.map((keyword) => `%${keyword}%`);
          const matches = await pool.query(
            `SELECT id, node_type, display_name, source_path, metadata
             FROM knowledge_graph_nodes
             WHERE display_name ILIKE ANY($1::text[])
                OR source_path ILIKE ANY($1::text[])
                OR node_key ILIKE ANY($1::text[])
             ORDER BY
               CASE node_type
                 WHEN 'symbol' THEN 1
                 WHEN 'file' THEN 2
                 WHEN 'document' THEN 3
                 WHEN 'dependency' THEN 4
                 ELSE 5
               END,
               updated_at DESC
             LIMIT $2`,
            [patterns, options.limit ?? 6]
          );

          return {
            matches: matches.rows,
            relationships: [],
            recentChanges: [],
            relatedLearnings: [],
          };
        }
      );

      if (
        !result ||
        (
          !result.matches?.length &&
          !result.relationships?.length &&
          !result.recentChanges?.length &&
          !result.relatedLearnings?.length
        )
      ) {
        return null;
      }

      return {
        ...result,
        lines: formatGraphContext(result),
      };
    },

    async analyzeImpact(queryText, options = {}) {
      const graphContext =
        options.graphContext ??
        (await this.retrieveRelevantContext(queryText, {
          limit: options.limit ?? 6,
          relationshipLimit: options.relationshipLimit ?? 10,
          changeLimit: options.changeLimit ?? 5,
          learningLimit: options.learningLimit ?? 4,
        }));

      return buildImpactAnalysis(queryText, graphContext);
    },
  };
}
