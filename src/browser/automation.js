import fs from 'node:fs/promises';
import path from 'node:path';

import { isBrowserOriginAllowed } from '../project/targets.js';

async function defaultPlaywrightLoader() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(
      'Browser automation requires the `playwright` package to be installed in this runtime.'
    );
  }
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function runAction(page, action) {
  switch (action.type) {
    case 'click':
      await page.click(action.selector, { timeout: action.timeoutMs ?? 15000 });
      return `Clicked ${action.selector}`;
    case 'fill':
      await page.fill(action.selector, action.value ?? '', {
        timeout: action.timeoutMs ?? 15000,
      });
      return `Filled ${action.selector}`;
    case 'press':
      await page.press(action.selector, action.value ?? 'Enter', {
        timeout: action.timeoutMs ?? 15000,
      });
      return `Pressed ${action.value ?? 'Enter'} on ${action.selector}`;
    case 'wait_for':
      await page.waitForSelector(action.selector, {
        timeout: action.timeoutMs ?? 15000,
      });
      return `Waited for ${action.selector}`;
    case 'assert_text': {
      const text = await page.textContent(action.selector, {
        timeout: action.timeoutMs ?? 15000,
      });
      if (!`${text ?? ''}`.includes(action.value ?? '')) {
        throw new Error(
          `Text assertion failed for ${action.selector}. Expected to include "${action.value ?? ''}".`
        );
      }
      return `Asserted text for ${action.selector}`;
    }
    default:
      throw new Error(`Unsupported browser action: ${action.type}`);
  }
}

export function createBrowserAutomation(options = {}) {
  const loadPlaywright = options.playwrightLoader ?? defaultPlaywrightLoader;

  return {
    async runScenario(input, context = {}) {
      if (!isBrowserOriginAllowed(input.url, context.projectTarget)) {
        throw new Error(
          'Browser automation is only allowed for localhost or project-allowed origins.'
        );
      }

      const workspaceRoot = context.workspaceRoot;
      if (!workspaceRoot) {
        throw new Error('Browser automation requires a workspace root.');
      }

      const screenshotPath = path.resolve(
        workspaceRoot,
        input.screenshotPath ?? '.stallone/browser/last-run.png'
      );
      const profileDir = path.resolve(workspaceRoot, '.stallone/browser/profile');
      await ensureParentDir(screenshotPath);
      await fs.mkdir(profileDir, { recursive: true });

      const playwright = await loadPlaywright();
      const browserType = playwright.chromium;
      const browser = await browserType.launchPersistentContext(profileDir, {
        headless: input.headless !== false,
      });
      const page = await browser.newPage();
      const consoleMessages = [];

      page.on('console', (message) => {
        consoleMessages.push(`${message.type()}: ${message.text()}`);
      });

      try {
        await page.goto(input.url, {
          waitUntil: input.waitUntil ?? 'domcontentloaded',
          timeout: input.timeoutMs ?? 30000,
        });

        const actionSummaries = [];
        for (const action of input.actions ?? []) {
          actionSummaries.push(await runAction(page, action));
        }

        if (input.captureScreenshot !== false) {
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }

        return {
          summary: `Browser automation completed for ${input.url}`,
          output: JSON.stringify(
            {
              url: page.url(),
              title: await page.title(),
              actions: actionSummaries,
              console: consoleMessages,
            },
            null,
            2
          ),
          artifacts: input.captureScreenshot === false
            ? []
            : [
                {
                  artifactType: 'browser_trace_v1',
                  artifactPath: screenshotPath,
                  metadata: {
                    url: page.url(),
                    consoleMessages,
                  },
                },
              ],
        };
      } finally {
        await browser.close();
      }
    },
  };
}
