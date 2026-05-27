import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';

function normalizePath(value) {
  return `${value ?? ''}`.replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeNodeKey(prefix, value) {
  return `${prefix}:${normalizePath(value)}`;
}

function normalizeDependencyName(specifier) {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }

  return specifier.split('/')[0];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function upsertMapEntry(map, key, value) {
  if (!key || map.has(key)) {
    return;
  }

  map.set(key, value);
}

function normalizeGenericNodes(rawNodes = []) {
  const nodes = new Map();

  for (const rawNode of rawNodes) {
    const nodeType = rawNode.nodeType ?? rawNode.type ?? 'file';
    const sourcePath = rawNode.sourcePath ?? rawNode.path ?? null;
    const displayName =
      rawNode.displayName ??
      rawNode.name ??
      (sourcePath ? path.basename(sourcePath) : `${nodeType}-node`);
    const nodeKey =
      rawNode.nodeKey ??
      (sourcePath ? normalizeNodeKey(nodeType, sourcePath) : `${nodeType}:${displayName}`);

    upsertMapEntry(nodes, nodeKey, {
      nodeKey,
      nodeType,
      displayName,
      sourcePath: sourcePath ? normalizePath(sourcePath) : null,
      metadata: rawNode.metadata ?? {},
    });
  }

  return nodes;
}

function normalizeGenericEdges(rawEdges = []) {
  return rawEdges
    .map((rawEdge) => ({
      fromNodeKey: rawEdge.fromNodeKey ?? rawEdge.from ?? rawEdge.source ?? null,
      toNodeKey: rawEdge.toNodeKey ?? rawEdge.to ?? rawEdge.target ?? null,
      edgeType: rawEdge.edgeType ?? rawEdge.type ?? 'references',
      metadata: rawEdge.metadata ?? {},
    }))
    .filter((edge) => edge.fromNodeKey && edge.toNodeKey);
}

function normalizeFileGraph(rawFiles = []) {
  const nodes = new Map();
  const edges = [];

  for (const rawFile of rawFiles) {
    const relativePath = normalizePath(rawFile.path ?? rawFile.relativePath ?? '');
    if (!relativePath) {
      continue;
    }

    const ext = path.extname(relativePath).toLowerCase();
    const nodeType = ['.md', '.mdx', '.txt'].includes(ext) ? 'document' : 'file';
    const fileNodeKey = normalizeNodeKey(nodeType, relativePath);
    upsertMapEntry(nodes, fileNodeKey, {
      nodeKey: fileNodeKey,
      nodeType,
      displayName: path.basename(relativePath),
      sourcePath: relativePath,
      metadata: rawFile.metadata ?? {},
    });

    for (const symbol of rawFile.symbols ?? []) {
      const symbolName = `${symbol.name ?? ''}`.trim();
      if (!symbolName) {
        continue;
      }

      const symbolNodeKey = `symbol:${relativePath}:${symbolName}`;
      upsertMapEntry(nodes, symbolNodeKey, {
        nodeKey: symbolNodeKey,
        nodeType: 'symbol',
        displayName: symbolName,
        sourcePath: relativePath,
        metadata: {
          kind: symbol.kind ?? 'symbol',
          exported: symbol.exported ?? false,
        },
      });
      edges.push({
        fromNodeKey: fileNodeKey,
        toNodeKey: symbolNodeKey,
        edgeType: 'contains',
        metadata: {
          symbolKind: symbol.kind ?? 'symbol',
          exported: symbol.exported ?? false,
        },
      });
    }

    for (const reference of rawFile.imports ?? rawFile.dependencies ?? []) {
      const specifier = `${reference.specifier ?? reference.path ?? reference.value ?? ''}`.trim();
      if (!specifier) {
        continue;
      }

      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const normalizedTarget = normalizePath(specifier);
        const targetNodeKey = normalizeNodeKey('file', normalizedTarget);
        upsertMapEntry(nodes, targetNodeKey, {
          nodeKey: targetNodeKey,
          nodeType: 'file',
          displayName: path.basename(normalizedTarget),
          sourcePath: normalizedTarget,
          metadata: {
            specifier,
          },
        });
        edges.push({
          fromNodeKey: fileNodeKey,
          toNodeKey: targetNodeKey,
          edgeType: 'imports',
          metadata: { specifier },
        });
      } else {
        const dependencyName = normalizeDependencyName(specifier);
        const dependencyNodeKey = `dependency:${dependencyName}`;
        upsertMapEntry(nodes, dependencyNodeKey, {
          nodeKey: dependencyNodeKey,
          nodeType: 'dependency',
          displayName: dependencyName,
          sourcePath: null,
          metadata: {
            specifier,
          },
        });
        edges.push({
          fromNodeKey: fileNodeKey,
          toNodeKey: dependencyNodeKey,
          edgeType: 'depends_on',
          metadata: { specifier },
        });
      }
    }

    for (const link of rawFile.references ?? rawFile.links ?? []) {
      const relativeTarget = normalizePath(link.path ?? link.target ?? link.value ?? '');
      if (!relativeTarget) {
        continue;
      }

      const targetType = ['.md', '.mdx', '.txt'].includes(path.extname(relativeTarget).toLowerCase())
        ? 'document'
        : 'file';
      const targetNodeKey = normalizeNodeKey(targetType, relativeTarget);
      upsertMapEntry(nodes, targetNodeKey, {
        nodeKey: targetNodeKey,
        nodeType: targetType,
        displayName: path.basename(relativeTarget),
        sourcePath: relativeTarget,
        metadata: {},
      });
      edges.push({
        fromNodeKey: fileNodeKey,
        toNodeKey: targetNodeKey,
        edgeType: 'references',
        metadata: {},
      });
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
  };
}

export function createGraphifyAdapter(options = {}) {
  const logger = options.logger ?? null;
  const configuredIndexPath = `${options.indexPath ?? config.graphifyIndexPath ?? ''}`.trim();

  return {
    async loadNormalizedGraph(input = {}) {
      const projectRoot = input.projectRoot ?? process.cwd();
      const candidatePath =
        configuredIndexPath ||
        path.join(projectRoot, '.stallone', 'graphify-index.json');

      if (!(await pathExists(candidatePath))) {
        return null;
      }

      const raw = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
      let nodes = normalizeGenericNodes(raw.nodes ?? []);
      let edges = normalizeGenericEdges(raw.edges ?? []);

      if (nodes.size === 0 && edges.length === 0 && Array.isArray(raw.files)) {
        const normalized = normalizeFileGraph(raw.files);
        nodes = new Map(normalized.nodes.map((node) => [node.nodeKey, node]));
        edges = normalized.edges;
      }

      if (nodes.size === 0) {
        logger?.warn?.({ candidatePath }, 'Graphify index was present but no graph entries were recognized');
        return null;
      }

      return {
        source: 'graphify',
        sourcePath: candidatePath,
        nodes: [...nodes.values()],
        edges,
      };
    },
  };
}

