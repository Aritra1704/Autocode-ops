import { config } from '../config.js';

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function createGitHubError(status, message, payload) {
  const error = new Error(message);
  error.status = status;
  error.payload = payload;
  return error;
}

export function createGitHubClient(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? config.githubApiBaseUrl);
  const token = options.token ?? config.githubPat;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available for the GitHub client');
  }

  async function request(pathname, requestOptions = {}) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method: requestOptions.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'stallone',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(requestOptions.headers ?? {}),
      },
      body:
        typeof requestOptions.body === 'undefined'
          ? undefined
          : JSON.stringify(requestOptions.body),
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw createGitHubError(
        response.status,
        payload?.message ?? `GitHub API request failed with status ${response.status}`,
        payload
      );
    }

    return payload;
  }

  return {
    async getAuthenticatedUser() {
      return request('/user');
    },

    async getRepository(owner, repo) {
      return request(`/repos/${owner}/${repo}`);
    },

    async createRepository(input) {
      return request('/user/repos', {
        method: 'POST',
        body: {
          name: input.name,
          description: input.description,
          private: input.private ?? true,
          auto_init: false,
        },
      });
    },

    async ensureRepository(input) {
      try {
        return await this.createRepository(input);
      } catch (error) {
        if (error.status === 422 || error.status === 403 || error.status === 404) {
          return this.getRepository(input.owner, input.name);
        }

        throw error;
      }
    },

    async createIssueComment(owner, repo, issueNumber, body) {
      return request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: {
          body,
        },
      });
    },
  };
}
