
CREATE TABLE IF NOT EXISTS knowledge_graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_key TEXT UNIQUE NOT NULL,
  node_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_path TEXT,
  checksum TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_nodes_type_updated
  ON knowledge_graph_nodes(node_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_nodes_source_path
  ON knowledge_graph_nodes(source_path);

CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node_id UUID NOT NULL REFERENCES knowledge_graph_nodes(id) ON DELETE CASCADE,
  to_node_id UUID NOT NULL REFERENCES knowledge_graph_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_graph_edges_unique UNIQUE (from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_from_type
  ON knowledge_graph_edges(from_node_id, edge_type);

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_to_type
  ON knowledge_graph_edges(to_node_id, edge_type);
