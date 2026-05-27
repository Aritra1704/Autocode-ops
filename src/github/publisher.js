import { config } from '../config.js';
import { buildRepositoryTarget, hasRepositoryMapping } from '../project/targets.js';

function sanitizeRepositoryName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildRepositoryDescription(task) {
  return task.description.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function deriveRepositoryName(task, context) {
  return sanitizeRepositoryName(
    task.project_name ?? task.title ?? context.workspaceName
  );
}

function parseRepositoryUrl(url) {
  if (!url) {
    return null;
  }

  const match = `${url}`.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
  };
}

export function createGitHubPublisher({ gitClient, githubClient, githubServer = null, logger }) {
  return {
    isEnabled() {
      return (
        config.githubAutoPublish &&
        Boolean(config.githubPat) &&
        Boolean(config.githubRepoOwner || config.githubUsername)
      );
    },

    async publishWorkspace(task, context) {
      const explicitTarget = buildRepositoryTarget(context.projectTarget);
      const owner =
        explicitTarget?.owner ?? (config.githubRepoOwner || config.githubUsername);
      const requestedExternalPublish =
        context.taskContract?.repoIntent?.publish === true ||
        context.taskContract?.repoIntent?.deploy === true;

      if (requestedExternalPublish && !hasRepositoryMapping(context.projectTarget)) {
        throw new Error(
          'This project does not have a GitHub repository mapping. Add the project repo target before publishing.'
        );
      }

      if (!owner) {
        throw new Error('GITHUB_REPO_OWNER or GITHUB_USERNAME is required for publish');
      }

      const repositoryName = explicitTarget?.name ?? deriveRepositoryName(task, context);

      if (!repositoryName) {
        throw new Error('Unable to derive a valid GitHub repository name for this task');
      }

      const repository = githubServer
        ? await githubServer.callTool('ensure_repository', {
            owner,
            name: repositoryName,
            description: buildRepositoryDescription(task),
            private: config.githubRepoVisibility !== 'public',
          })
        : await githubClient.ensureRepository({
            owner,
            name: repositoryName,
            description: buildRepositoryDescription(task),
            private: config.githubRepoVisibility !== 'public',
          });
      const publishBranch = repository.default_branch || config.gitDefaultBranch;

      await gitClient.initRepository(context.workspaceRoot, {
        branch: publishBranch,
      });
      await gitClient.ensureRemote(context.workspaceRoot, 'origin', repository.clone_url);

      const commitResult = await gitClient.commitAll(
        context.workspaceRoot,
        `feat: bootstrap ${repositoryName} via stallone`
      );

      await gitClient.pushBranch(context.workspaceRoot, {
        remoteName: 'origin',
        branch: publishBranch,
        token: config.githubPat,
      });

      logger?.info(
        {
          taskId: task.id,
          repositoryName,
          repositoryUrl: repository.html_url,
        },
        'Published workspace to GitHub'
      );

      return {
        attempted: true,
        published: true,
        repo: {
          owner,
          name: repository.name,
          htmlUrl: repository.html_url,
          cloneUrl: repository.clone_url,
          defaultBranch: publishBranch,
        },
        commit: {
          sha: commitResult.commitSha,
          created: commitResult.createdCommit,
        },
      };
    },

    async publishReviewDraft(task, input = {}) {
      if (!this.isEnabled()) {
        throw new Error('GitHub publishing is not enabled.');
      }

      const repository =
        (input.owner && input.repo ? { owner: input.owner, repo: input.repo } : null) ??
        parseRepositoryUrl(input.repoUrl);

      if (!repository?.owner || !repository?.repo) {
        throw new Error('A valid GitHub owner and repository are required to publish a review draft.');
      }

      if (!Number.isInteger(Number(input.issueNumber)) || Number(input.issueNumber) <= 0) {
        throw new Error('A positive pull request number is required to publish a review draft.');
      }

      if (!`${input.body ?? ''}`.trim()) {
        throw new Error('Review draft body is empty.');
      }

      const comment = await githubClient.createIssueComment(
        repository.owner,
        repository.repo,
        Number(input.issueNumber),
        input.body
      );

      logger?.info(
        {
          taskId: task.id,
          repository: `${repository.owner}/${repository.repo}`,
          issueNumber: Number(input.issueNumber),
        },
        'Published GitHub review draft comment'
      );

      return {
        owner: repository.owner,
        repo: repository.repo,
        issueNumber: Number(input.issueNumber),
        commentId: comment.id,
        commentUrl: comment.html_url ?? null,
        body: input.body,
      };
    },
  };
}
