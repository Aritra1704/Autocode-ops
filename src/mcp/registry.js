export function createMcpRegistry(options = {}) {
  const serverMap = new Map();

  for (const server of options.servers ?? []) {
    if (!server?.name) {
      throw new Error('MCP servers must provide a stable name.');
    }

    serverMap.set(server.name, server);
  }

  return {
    registerServer(server) {
      if (!server?.name) {
        throw new Error('MCP servers must provide a stable name.');
      }

      serverMap.set(server.name, server);
    },

    getServer(name) {
      return serverMap.get(name) ?? null;
    },

    listServers() {
      return [...serverMap.values()].map((server) => ({
        name: server.name,
        description: server.description ?? '',
      }));
    },

    listTools(serverName) {
      const server = serverMap.get(serverName);
      if (!server) {
        throw new Error(`Unknown MCP server: ${serverName}`);
      }

      return typeof server.listTools === 'function' ? server.listTools() : [];
    },

    listAllTools() {
      return this.listServers().map((server) => ({
        ...server,
        tools: this.listTools(server.name),
      }));
    },

    async callTool(serverName, toolName, args = {}, context = {}) {
      const server = serverMap.get(serverName);
      if (!server) {
        throw new Error(`Unknown MCP server: ${serverName}`);
      }

      if (typeof server.callTool !== 'function') {
        throw new Error(`MCP server ${serverName} does not implement callTool().`);
      }

      return server.callTool(toolName, args, context);
    },
  };
}
