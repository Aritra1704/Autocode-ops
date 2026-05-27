import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function clampScore(value) {
  return Math.min(Math.max(value, 0), 1);
}

function scoreFromAge(secondsAgo, maxAgeSeconds) {
  if (!Number.isFinite(secondsAgo)) {
    return 0;
  }

  return clampScore(1 - secondsAgo / maxAgeSeconds);
}

async function getPresenceSignal(pool, source, maxAgeSeconds) {
  try {
    const result = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - recorded_at)) AS seconds_ago
         FROM presence_log
        WHERE source = $1
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [source]
    );
    const secondsAgo = Number(result.rows[0]?.seconds_ago);
    return scoreFromAge(secondsAgo, maxAgeSeconds);
  } catch {
    return 0;
  }
}

async function getGitActivitySignal(workspaceRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%ct'], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    const lastCommitEpoch = Number.parseInt(String(stdout).trim(), 10);
    if (!Number.isFinite(lastCommitEpoch)) {
      return 0;
    }

    const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000) - lastCommitEpoch);
    return scoreFromAge(secondsAgo, 7200);
  } catch {
    return 0;
  }
}

function getTimeOfDaySignal() {
  try {
    const hour = new Date().getHours();
    return hour >= 9 && hour <= 20 ? 1 : 0.3;
  } catch {
    return 0;
  }
}

export async function computePresenceScore(pool, workspaceRoot) {
  const [telegramRecency, dashboardPing, gitActivity] = await Promise.all([
    getPresenceSignal(pool, 'telegram', 3600),
    getPresenceSignal(pool, 'dashboard', 1800),
    getGitActivitySignal(workspaceRoot),
  ]);
  const timeOfDay = getTimeOfDaySignal();

  const score = clampScore(
    telegramRecency * 0.4 + dashboardPing * 0.3 + gitActivity * 0.2 + timeOfDay * 0.1
  );

  return {
    score,
    signals: {
      telegramRecency,
      dashboardPing,
      gitActivity,
      timeOfDay,
    },
  };
}

export function isHumanOnline(score) {
  return score >= 0.5;
}
