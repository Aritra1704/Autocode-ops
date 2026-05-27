import { Telegraf } from 'telegraf';

import { config } from '../config.js';
import { registerTelegramCommands } from './commands.js';

async function withTimeout(promise, timeoutMs, message) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildTelegramBot(dependencies) {
  const { logger } = dependencies;
  if (!config.telegramBotToken || !config.telegramChatId) {
    return null;
  }

  const bot = new Telegraf(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();

    if (chatId !== config.telegramChatId) {
      logger.warn({ chatId }, 'Ignoring Telegram message from unauthorized chat');
      return;
    }

    await next();
  });

  bot.catch((error, ctx) => {
    logger.error(
      {
        err: error,
        updateType: ctx.updateType,
      },
      'Telegram bot handler failed'
    );
  });

  registerTelegramCommands(bot, dependencies);

  return bot;
}

export async function startTelegramBot(dependencies) {
  const { logger } = dependencies;
  const bot = buildTelegramBot(dependencies);

  if (!bot) {
    logger.warn(
      'Telegram bot not started because TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.'
    );
    return null;
  }

  bot.botInfo = await withTimeout(
    bot.telegram.getMe(),
    5000,
    'Timed out while validating the Telegram bot token with getMe().'
  );

  await withTimeout(
    bot.telegram.deleteWebhook({ drop_pending_updates: false }),
    5000,
    'Timed out while clearing the Telegram webhook before polling startup.'
  );

  const launchPromise = bot
    .launch({ dropPendingUpdates: false })
    .catch((error) => {
      logger.error({ err: error }, 'Telegram polling stopped unexpectedly');
      throw error;
    });

  logger.info(
    { chatId: config.telegramChatId, username: bot.botInfo.username },
    'Telegram bot started'
  );

  return {
    bot,
    async sendMessage(text, options = {}) {
      return bot.telegram.sendMessage(config.telegramChatId, text, {
        disable_web_page_preview: true,
        ...options,
      });
    },
    async stop() {
      await bot.stop();
      await launchPromise.catch(() => {});
      logger.info('Telegram bot stopped');
    },
  };
}
