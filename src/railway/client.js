import { config } from '../config.js';

export const RAILWAY_ACTIVE_STATUSES = new Set([
  'BUILDING',
  'DEPLOYING',
  'INITIALIZING',
  'QUEUED',
  'WAITING',
]);

export const RAILWAY_SUCCESS_STATUSES = new Set(['SUCCESS', 'SLEEPING']);
export const RAILWAY_FAILURE_STATUSES = new Set([
  'CRASHED',
  'FAILED',
  'REMOVED',
  'SKIPPED',
]);

function normalizeResponseText(text) {
  return text?.trim() ?? '';
}

function createRailwayError(message, payload) {
  const error = new Error(message);
  error.payload = payload;
  return error;
}

export function createRailwayClient(options = {}) {
  const endpoint = options.endpoint ?? config.railwayGraphqlEndpoint;
  const token = options.token ?? config.railwayApiToken;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available for the Railway client');
  }

  async function request(query, variables = {}) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    const text = normalizeResponseText(await response.text());
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw createRailwayError(
        `Railway request failed with status ${response.status}`,
        payload
      );
    }

    if (payload.errors?.length) {
      throw createRailwayError(
        payload.errors.map((item) => item.message).join('; '),
        payload
      );
    }

    return payload.data;
  }

  return {
    async listProjects() {
      const data = await request(`
        query {
          projects {
            edges {
              node {
                id
                name
                environments {
                  edges {
                    node {
                      id
                      name
                    }
                  }
                }
                services {
                  edges {
                    node {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `);

      return data.projects.edges.map((edge) => edge.node);
    },

    async triggerDeployment(input) {
      const data = await request(
        `
          mutation TriggerServiceDeploy(
            $serviceId: String!,
            $environmentId: String!,
            $commitSha: String
          ) {
            serviceInstanceDeployV2(
              serviceId: $serviceId,
              environmentId: $environmentId,
              commitSha: $commitSha
            )
          }
        `,
        {
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          commitSha: input.commitSha ?? null,
        }
      );

      return data.serviceInstanceDeployV2;
    },

    async getDeployment(deploymentId) {
      const data = await request(
        `
          query Deployment($id: String!) {
            deployment(id: $id) {
              id
              status
              createdAt
              updatedAt
              url
              staticUrl
              projectId
              environmentId
              serviceId
            }
          }
        `,
        { id: deploymentId }
      );

      return data.deployment;
    },

    async getDeploymentLogs(deploymentId, limit = 50) {
      const data = await request(
        `
          query DeploymentLogs($deploymentId: String!, $limit: Int) {
            deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
              timestamp
              severity
              message
            }
          }
        `,
        {
          deploymentId,
          limit,
        }
      );

      return data.deploymentLogs ?? [];
    },

    async getService(serviceId) {
      const data = await request(
        `
          query Service($id: String!) {
            service(id: $id) {
              id
              name
            }
          }
        `,
        { id: serviceId }
      );

      return data.service;
    },
  };
}
