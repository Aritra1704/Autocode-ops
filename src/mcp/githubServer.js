const GITHUB_TOOLS = [
  {
    name: 'get_authenticated_user',
    description: 'Resolve the authenticated GitHub user.',
  },
  {
    name: 'get_repository',
    description: 'Fetch repository metadata by owner and repo.',
  },
  {
    name: 'ensure_repository',
    description: 'Create or fetch a repository that should exist for publication.',
  },
];

export function createGitHubMcpServer({ client }) {
  if (!client) {
    throw new Error('GitHub MCP server requires a GitHub client.');
  }

  return {
    name: 'github',
    description: 'Standardized Stallone GitHub repository operations.',

    listTools() {
      return GITHUB_TOOLS.map((tool) => ({ ...tool }));
    },

    async callTool(toolName, args = {}) {
      switch (toolName) {
        case 'get_authenticated_user':
          return client.getAuthenticatedUser();
        case 'get_repository':
          return client.getRepository(args.owner, args.repo);
        case 'ensure_repository':
          return client.ensureRepository(args);
        default:
          throw new Error(`Unsupported GitHub MCP tool: ${toolName}`);
      }
    },
  };
}
