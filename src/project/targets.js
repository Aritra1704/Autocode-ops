function trimString(value) {
  const text = `${value ?? ''}`.trim();
  return text ? text : null;
}

export function normalizeProjectTarget(projectTarget = null) {
  if (!projectTarget) {
    return null;
  }

  return {
    ...projectTarget,
    github_repo_owner: trimString(projectTarget.github_repo_owner),
    github_repo_name: trimString(projectTarget.github_repo_name),
    railway_project_id: trimString(projectTarget.railway_project_id),
    railway_environment_id: trimString(projectTarget.railway_environment_id),
    railway_service_id: trimString(projectTarget.railway_service_id),
    railway_service_name: trimString(projectTarget.railway_service_name),
    browser_allowed_origins: Array.isArray(projectTarget.browser_allowed_origins)
      ? projectTarget.browser_allowed_origins
          .map((origin) => trimString(origin))
          .filter(Boolean)
      : [],
  };
}

export function hasRepositoryMapping(projectTarget = null) {
  const normalized = normalizeProjectTarget(projectTarget);
  return Boolean(normalized?.github_repo_owner && normalized?.github_repo_name);
}

export function hasDeployMapping(projectTarget = null) {
  const normalized = normalizeProjectTarget(projectTarget);
  return Boolean(
    normalized?.railway_project_id &&
      normalized?.railway_environment_id &&
      normalized?.railway_service_id
  );
}

export function buildRepositoryTarget(projectTarget = null) {
  if (!hasRepositoryMapping(projectTarget)) {
    return null;
  }

  const normalized = normalizeProjectTarget(projectTarget);
  return {
    owner: normalized.github_repo_owner,
    name: normalized.github_repo_name,
  };
}

export function buildDeployTarget(projectTarget = null) {
  if (!hasDeployMapping(projectTarget)) {
    return null;
  }

  const normalized = normalizeProjectTarget(projectTarget);
  return {
    projectId: normalized.railway_project_id,
    environmentId: normalized.railway_environment_id,
    serviceId: normalized.railway_service_id,
    serviceName: normalized.railway_service_name,
  };
}

export function isBrowserOriginAllowed(url, projectTarget = null) {
  const normalized = normalizeProjectTarget(projectTarget);
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return true;
  }

  if (!normalized) {
    return false;
  }

  return normalized.browser_allowed_origins.includes(parsed.origin);
}
