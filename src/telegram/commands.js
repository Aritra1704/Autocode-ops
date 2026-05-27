function formatTimestamp(value) {
  if (!value) {
    return 'n/a';
  }

  return new Date(value).toISOString();
}

const APPROVAL_ACTION_PATTERN = /^approval:(approve|reject|approve_repair|reject_repair):([0-9a-f-]{36})$/i;

function formatTaskLine(task) {
  return [
    `- ${task.title}`,
    `  id: ${task.id}`,
    `  status: ${task.status}`,
    `  priority: ${task.priority}`,
    `  created: ${formatTimestamp(task.created_at)}`,
  ].join('\n');
}

export function createTelegramHandlers(dependencies) {
  const { orchestrator, logger, onKill, pool } = dependencies;

  return {
    start: async (ctx) => {
      await ctx.reply(
        'Stallone bot is connected.\nPrimary control: stallone CLI (plan/run).\nTelegram commands: /status /tasks /approvals /approve /reject /skills /enable_skill /disable_skill /online /offline /done /pause /resume /kill'
      );
    },

    status: async (ctx) => {
      const snapshot = await orchestrator.getStatusSnapshot();
      const uptimeStart = snapshot.stats?.uptime_start
        ? new Date(snapshot.stats.uptime_start).toISOString()
        : 'n/a';

      const lines = [
        `Status: ${snapshot.status}`,
        `Boot phase: ${snapshot.bootPhase}`,
        `Polling active: ${snapshot.pollingActive ? 'yes' : 'no'}`,
        `Instance: ${snapshot.instanceId}`,
        `Poll interval: ${snapshot.pollIntervalMs} ms`,
        `Pending: ${snapshot.queue.pending_count}`,
        `In progress: ${snapshot.queue.in_progress_count}`,
        `Blocked: ${snapshot.queue.blocked_count}`,
        `Waiting approval: ${snapshot.queue.waiting_approval_count}`,
        `Pending approvals: ${snapshot.approvals?.pending_count ?? 0}`,
        `Deploying: ${snapshot.deployments?.deploying_count ?? 0}`,
        `Current task: ${snapshot.currentTask?.title ?? 'none'}`,
        `Completed: ${snapshot.stats?.tasks_completed ?? 0}`,
        `Failed: ${snapshot.stats?.tasks_failed ?? 0}`,
        `Uptime start: ${uptimeStart}`,
      ];

      if (snapshot.pauseReason) {
        lines.push(`Pause reason: ${snapshot.pauseReason}`);
      }

      if (snapshot.bootError) {
        lines.push(`Boot error: ${snapshot.bootError}`);
      }

      await ctx.reply(lines.join('\n'));
    },

    pause: async (ctx) => {
      const reason =
        ctx.message.text.replace(/^\/pause\s*/, '').trim() || 'Paused via Telegram';
      await orchestrator.pause(reason);
      logger.info({ reason }, 'Pause requested from Telegram');
      await ctx.reply(`Stallone paused.\nReason: ${reason}`);
    },

    resume: async (ctx) => {
      await orchestrator.resume();
      logger.info('Resume requested from Telegram');
      await ctx.reply('Stallone resumed.');
    },

    online: async (ctx) => {
      await pool.query(
        `INSERT INTO presence_log (source, score, recorded_at)
         VALUES ('telegram', 1.0, NOW())`
      );
      logger.info('Online presence recorded from Telegram');
      await ctx.reply(
        "✅ Marked as online. Stallone will delegate tasks to you when you're needed."
      );
    },

    offline: async (ctx) => {
      await pool.query(
        `INSERT INTO presence_log (source, score, recorded_at)
         VALUES ('telegram', 0.0, NOW())`
      );
      logger.info('Offline presence recorded from Telegram');
      await ctx.reply('⏸ Marked as offline. Stallone will work autonomously.');
    },

    done: async (ctx) => {
      logger.info('Delegated step completion acknowledged from Telegram');
      await ctx.reply('👍 Got it. Stallone will pick up from your commit.');
    },

    tasks: async (ctx) => {
      const tasks = await orchestrator.listTasks(10);

      if (tasks.length === 0) {
        await ctx.reply(
          'No active tasks in pending, in-progress, blocked, or approval states.'
        );
        return;
      }

      const response = tasks.map(formatTaskLine).join('\n\n');
      await ctx.reply(response);
    },

    add: async (ctx) => {
      const description = ctx.message.text.replace(/^\/add\s*/, '').trim();

      if (!description) {
        await ctx.reply('Usage: /add <task description>');
        return;
      }

      const task = await orchestrator.createTask(description, { source: 'telegram' });
      logger.info({ taskId: task.id, title: task.title }, 'Task created from Telegram');

      await ctx.reply(
        `Task created.\nTitle: ${task.title}\nID: ${task.id}\nPriority: ${task.priority}\nStatus: ${task.status}`
      );
    },

    approvals: async (ctx) => {
      const approvals = await orchestrator.listPendingApprovals(10);

      if (approvals.length === 0) {
        await ctx.reply('No pending deploy approvals.');
        return;
      }

      const lines = approvals.map((approval) =>
        [
          `- ${approval.task_title}`,
          `  approval: ${approval.id}`,
          `  task: ${approval.task_id}`,
          `  repo: ${approval.repo_url ?? 'n/a'}`,
          `  target: ${approval.target_env} (${approval.service_id ?? 'service not set'})`,
          `  requested: ${formatTimestamp(approval.requested_at)}`,
        ].join('\n')
      );

      await ctx.reply(lines.join('\n\n'));
    },

    skills: async (ctx) => {
      const skills = await orchestrator.listSkills({
        includeDisabled: true,
        limit: 20,
      });

      if (skills.length === 0) {
        await ctx.reply('No skills are registered.');
        return;
      }

      const lines = skills.map((skill) =>
        [
          `- ${skill.name} (v${skill.version})`,
          `  source: ${skill.source_type}`,
          `  enabled: ${skill.is_enabled ? 'yes' : 'no'}`,
          `  runs: ${skill.total_runs} (success=${skill.success_runs}, failed=${skill.failed_runs})`,
          `  last run: ${formatTimestamp(skill.last_run_at)}`,
        ].join('\n')
      );

      await ctx.reply(lines.join('\n\n'));
    },

    enableSkill: async (ctx) => {
      const name = ctx.message.text.replace(/^\/enable_skill\s*/, '').trim();
      if (!name) {
        await ctx.reply('Usage: /enable_skill <skill_name>');
        return;
      }

      const updated = await orchestrator.setSkillEnabled(name, true);
      if (!updated) {
        await ctx.reply(`Skill not found: ${name}`);
        return;
      }

      await ctx.reply(`Skill enabled.\nName: ${updated.name}\nVersion: ${updated.version}`);
    },

    disableSkill: async (ctx) => {
      const name = ctx.message.text.replace(/^\/disable_skill\s*/, '').trim();
      if (!name) {
        await ctx.reply('Usage: /disable_skill <skill_name>');
        return;
      }

      const updated = await orchestrator.setSkillEnabled(name, false);
      if (!updated) {
        await ctx.reply(`Skill not found: ${name}`);
        return;
      }

      await ctx.reply(`Skill disabled.\nName: ${updated.name}\nVersion: ${updated.version}`);
    },

    approve: async (ctx) => {
      const value = ctx.message.text.replace(/^\/approve\s*/, '').trim();

      if (!value) {
        await ctx.reply('Usage: /approve <approval_id>');
        return;
      }

      const approval = await orchestrator.approveApproval(value, {
        respondedVia: 'telegram',
      });

      if (!approval) {
        await ctx.reply('Approval not found or already handled.');
        return;
      }

      logger.info({ approvalId: value }, 'Deploy approval granted from Telegram');
      await ctx.reply(
        `Deployment approved.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nRailway deploy will be triggered on the next processing cycle.`
      );
    },

    reject: async (ctx) => {
      const value = ctx.message.text.replace(/^\/reject\s*/, '').trim();

      if (!value) {
        await ctx.reply('Usage: /reject <approval_id> [reason]');
        return;
      }

      const [approvalId, ...reasonParts] = value.split(/\s+/);
      const reason = reasonParts.join(' ').trim() || 'Rejected via Telegram';
      const approval = await orchestrator.rejectApproval(approvalId, {
        respondedVia: 'telegram',
        reason,
      });

      if (!approval) {
        await ctx.reply('Approval not found or already handled.');
        return;
      }

      logger.info({ approvalId, reason }, 'Deploy approval rejected from Telegram');
      await ctx.reply(
        `Deployment rejected.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nReason: ${reason}`
      );
    },

    approveRepair: async (ctx) => {
      const value = ctx.message.text.replace(/^\/approve_repair\s*/, '').trim();

      if (!value) {
        await ctx.reply('Usage: /approve_repair <approval_id>');
        return;
      }

      const approval = await orchestrator.approveApproval(value, {
        respondedVia: 'telegram',
      });

      if (!approval) {
        await ctx.reply('Approval not found or already handled.');
        return;
      }

      logger.info({ approvalId: value }, 'Repair approval granted from Telegram');
      await ctx.reply(
        `Repair approved.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nRepair will be applied on the next processing cycle.`
      );
    },

    rejectRepair: async (ctx) => {
      const value = ctx.message.text.replace(/^\/reject_repair\s*/, '').trim();

      if (!value) {
        await ctx.reply('Usage: /reject_repair <approval_id> [reason]');
        return;
      }

      const [approvalId, ...reasonParts] = value.split(/\s+/);
      const reason = reasonParts.join(' ').trim() || 'Repair rejected via Telegram';
      const approval = await orchestrator.rejectApproval(approvalId, {
        respondedVia: 'telegram',
        reason,
      });

      if (!approval) {
        await ctx.reply('Approval not found or already handled.');
        return;
      }

      logger.info({ approvalId, reason }, 'Repair approval rejected from Telegram');
      await ctx.reply(
        `Repair rejected.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nReason: ${reason}`
      );
    },

    approvalAction: async (ctx) => {
      const data = ctx.callbackQuery?.data ?? '';
      const match = data.match(APPROVAL_ACTION_PATTERN);

      if (!match) {
        await ctx.answerCbQuery('Invalid approval action.');
        return;
      }

      const action = match[1].toLowerCase();
      const approvalId = match[2];

      if (action === 'approve') {
        const approval = await orchestrator.approveApproval(approvalId, {
          respondedVia: 'telegram_button',
        });

        if (!approval) {
          await ctx.answerCbQuery('Approval already handled.');
          return;
        }

        logger.info({ approvalId }, 'Deploy approval granted from Telegram button');
        await ctx.answerCbQuery('Deployment approved.');
        await ctx.reply(
          `Deployment approved.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nRailway deploy will be triggered on the next processing cycle.`
        );
      } else if (action === 'approve_repair') {
        const approval = await orchestrator.approveApproval(approvalId, {
          respondedVia: 'telegram_button',
        });

        if (!approval) {
          await ctx.answerCbQuery('Approval already handled.');
          return;
        }

        logger.info({ approvalId }, 'Repair approval granted from Telegram button');
        await ctx.answerCbQuery('Repair approved.');
        await ctx.reply(
          `Repair approved.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nRepair will be applied on the next processing cycle.`
        );
      } else if (action === 'reject_repair') {
        const reason = 'Repair rejected via Telegram button';
        const approval = await orchestrator.rejectApproval(approvalId, {
          respondedVia: 'telegram_button',
          reason,
        });

        if (!approval) {
          await ctx.answerCbQuery('Approval already handled.');
          return;
        }

        logger.info({ approvalId, reason }, 'Repair approval rejected from Telegram button');
        await ctx.answerCbQuery('Repair rejected.');
        await ctx.reply(
          `Repair rejected.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nReason: ${reason}`
        );
      } else {
        const reason = 'Rejected via Telegram button';
        const approval = await orchestrator.rejectApproval(approvalId, {
          respondedVia: 'telegram_button',
          reason,
        });

        if (!approval) {
          await ctx.answerCbQuery('Approval already handled.');
          return;
        }

        logger.info({ approvalId, reason }, 'Deploy approval rejected from Telegram button');
        await ctx.answerCbQuery('Deployment rejected.');
        await ctx.reply(
          `Deployment rejected.\nApproval: ${approval.id}\nTask: ${approval.task_id}\nReason: ${reason}`
        );
      }

      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (error) {
        logger.debug({ err: error }, 'Could not clear approval inline keyboard');
      }
    },

    kill: async (ctx) => {
      const reason =
        ctx.message.text.replace(/^\/kill\s*/, '').trim() || 'Killed via Telegram';
      await orchestrator.markStopped(reason);
      logger.warn({ reason }, 'Kill requested from Telegram');
      await ctx.reply(`Stallone stopping now.\nReason: ${reason}`);

      if (typeof onKill === 'function') {
        setTimeout(() => {
          onKill(reason).catch((error) => {
            logger.error({ err: error }, 'Kill hook failed');
          });
        }, 50);
      }
    },
  };
}

export function registerTelegramCommands(bot, dependencies) {
  const handlers = createTelegramHandlers(dependencies);

  bot.start(handlers.start);
  bot.command('status', handlers.status);
  bot.command('pause', handlers.pause);
  bot.command('resume', handlers.resume);
  bot.command('online', handlers.online);
  bot.command('offline', handlers.offline);
  bot.command('done', handlers.done);
  bot.command('tasks', handlers.tasks);
  bot.command('add', handlers.add);
  bot.command('approvals', handlers.approvals);
  bot.command('approve', handlers.approve);
  bot.command('reject', handlers.reject);
  bot.command('approve_repair', handlers.approveRepair);
  bot.command('reject_repair', handlers.rejectRepair);
  bot.command('skills', handlers.skills);
  bot.command('enable_skill', handlers.enableSkill);
  bot.command('disable_skill', handlers.disableSkill);
  bot.command('kill', handlers.kill);
  bot.action(APPROVAL_ACTION_PATTERN, handlers.approvalAction);
}
