// 优先使用项目内的 playwright-core，再查找当前 Node 对应的全局安装。
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright-core');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  const globalModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  playwright = createRequire(join(globalModules, 'package.json'))('playwright-core');
}
export const { chromium } = playwright;
export const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
