// 用真实前端截取演示素材（2x 分辨率），输出到 demo-video/shots/。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, installMock, USERS, ME, T0 } from './mock.mjs';

const require = createRequire('/root/.nvm/versions/node/v22.13.1/lib/node_modules/');
const { chromium } = require('playwright-core');
const OUT = fileURLToPath(new URL('../shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const want = name => !only.length || only.includes(name);

const { port } = await startServer();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none'] });

async function open({ width = 1440, height = 900, mobile = false, authenticated = false, guestName = '小满', voiceMembers = [], palette, search = '', extraLive = [], withMine = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block',
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.addInitScript(([name, pal, auth]) => {
    try {
      if (name) localStorage.setItem('nightcord-guest-name', name);
      if (pal) localStorage.setItem('nightcord-palette', pal);
      localStorage.setItem('nightcord-rounded-corners', 'on');
    } catch {}
  }, [guestName, palette, authenticated]);
  await installMock(page, { port, authenticated, voiceMembers, extraLive, withMine });
  await page.clock.setFixedTime(T0 + 11 * 60000);
  await page.goto(`http://127.0.0.1:${port}/${search}`, { waitUntil: 'load' });
  return { page, context };
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const shot = async (page, name, opts = {}) => { await page.screenshot({ path: `${OUT}${name}.png`, ...opts }); console.log('  ✓', name); };

try {
  if (want('chooser')) {
    console.log('chooser');
    const { page, context } = await open({ guestName: '' });
    await page.waitForSelector('#name-chooser:not(.hidden)');
    await settle(page);
    await shot(page, 'chooser');
    await context.close();
  }

  if (want('chat')) {
    console.log('chat');
    const { page, context } = await open();
    await page.waitForSelector('.message');
    await settle(page, 1500);
    await shot(page, 'chat');
    await context.close();
  }

  if (want('indigo')) {
    console.log('indigo');
    const { page, context } = await open({ palette: 'indigo' });
    await page.waitForSelector('.message'); await settle(page, 1200);
    await shot(page, 'chat-indigo');
    await context.close();
  }
  if (want('plum')) {
    console.log('plum');
    const { page, context } = await open({ palette: 'plum-orchid' });
    await page.waitForSelector('.message'); await settle(page, 1200);
    await shot(page, 'chat-plum');
    await context.close();
  }
  if (want('settings')) {
    console.log('settings');
    const { page, context } = await open();
    await page.waitForSelector('.message'); await settle(page, 800);
    await page.click('#navigation-settings'); await settle(page, 1000);
    await shot(page, 'settings');
    await context.close();
  }
  if (want('search')) {
    console.log('search');
    const { page, context } = await open();
    await page.waitForSelector('.message'); await settle(page, 800);
    await page.click('#navigation-search'); await settle(page, 600);
    await page.keyboard.type('草稿'); await settle(page, 900);
    await shot(page, 'search');
    await context.close();
  }
  const min = n => T0 + n * 60000;
  const live = [
    { delay: 50, build: me => ({ timestamp: min(9.4), name: '凛', user: USERS.rin, message: `<$SEKAI:Reply::${min(2.5)}>当然，我这边也备好了` }) },
    { delay: 120, build: me => ({ timestamp: min(9.6), name: '夜航', user: USERS.ya, message: `<$SEKAI:Mention:type=user;display=${encodeURIComponent('小满')}:${me.id}> 提纲收到，辛苦啦` }) },
  ];
  if (want('inbox')) {
    console.log('inbox');
    const { page, context } = await open({ withMine: true, extraLive: live });
    await page.waitForSelector('.message'); await settle(page, 1500);
    await page.click('#navigation-inbox'); await settle(page, 1000);
    await shot(page, 'inbox');
    await context.close();
  }
  if (want('notify')) {
    console.log('notify');
    const { page, context } = await open({ withMine: true, extraLive: [{ ...live[1], delay: 1200 }] });
    await page.waitForSelector('.message'); await settle(page, 2600);
    await shot(page, 'notify');
    await context.close();
  }
  if (want('chooser-typed')) {
    console.log('chooser-typed');
    const { page, context } = await open({ guestName: '' });
    await page.waitForSelector('#name-chooser:not(.hidden)'); await settle(page, 600);
    await page.fill('#name-input', '小满'); await settle(page, 700);
    await shot(page, 'chooser-typed');
    await context.close();
  }
  if (want('steps')) {
    console.log('steps');
    {
      const { page, context } = await open({ guestName: '' });
      await page.waitForSelector('#name-chooser:not(.hidden)'); await settle(page, 600);
      await page.click('#name-input'); await page.keyboard.type('小'); await settle(page, 350);
      await shot(page, 'chooser-typed-1');
      await context.close();
    }
    {
      const { page, context } = await open();
      await page.waitForSelector('.message'); await settle(page, 900);
      await page.click('#messageInput'); await page.keyboard.type('提纲来啦，大家看看～'); await settle(page, 500);
      await shot(page, 'chat-typed');
      await page.keyboard.press('Enter'); await settle(page, 1400);
      await shot(page, 'chat-sent');
      await context.close();
    }
    {
      const { page, context } = await open();
      await page.waitForSelector('.message'); await settle(page, 800);
      await page.click('#navigation-search'); await settle(page, 700);
      await page.mouse.move(1400, 700);
      await shot(page, 'search-0');
      await page.keyboard.type('草'); await settle(page, 700);
      await shot(page, 'search-1');
      await page.keyboard.type('稿'); await settle(page, 700);
      await shot(page, 'search-2');
      await context.close();
    }
  }
  if (want('clean')) {
    console.log('clean');
    const hide = page => page.evaluate(() => document.querySelectorAll('.notice-card, .sekai-notice, .reply-notice, .mention-notice').forEach(n => { n.style.display = 'none'; }));
    {
      const { page, context } = await open({ withMine: true, extraLive: [{ ...live[1], delay: 600 }] });
      await page.waitForSelector('.message'); await settle(page, 2200);
      await hide(page); await settle(page, 300);
      await shot(page, 'notify-clean');
      await context.close();
    }
    {
      const { page, context } = await open({ withMine: true, extraLive: live });
      await page.waitForSelector('.message'); await settle(page, 1500);
      await page.click('#navigation-inbox'); await settle(page, 1000);
      await hide(page); await settle(page, 300);
      await shot(page, 'inbox-clean');
      await context.close();
    }
  }
  if (want('strips')) {
    console.log('strips');
    const { page, context } = await open();
    await page.waitForSelector('.message'); await settle(page, 900);
    await page.click('#messageInput'); await settle(page, 500);
    const clip = { x: 340, y: 810, width: 1100, height: 90 };
    await page.screenshot({ path: `${OUT}strip-0.png`, clip });
    const text = '提纲来啦，大家看看～';
    for (let i = 1; i <= [...text].length; i++) {
      await page.keyboard.type([...text][i - 1]); await settle(page, 160);
      await page.screenshot({ path: `${OUT}strip-${i}.png`, clip });
    }
    console.log('  ✓ strips', [...text].length);
    await context.close();
  }
  for (const [name, pal] of [['settings-indigo', 'indigo'], ['settings-plum', 'plum-orchid']]) {
    if (!want(name)) continue;
    console.log(name);
    const { page, context } = await open({ palette: pal });
    await page.waitForSelector('.message'); await settle(page, 800);
    await page.click('#navigation-settings'); await settle(page, 1000);
    await shot(page, name);
    await context.close();
  }
  if (want('tasks')) {
    console.log('tasks');
    const { page, context } = await open();
    await page.waitForSelector('.message'); await settle(page, 800);
    await page.click('#navigation-tasks'); await settle(page, 900);
    await shot(page, 'tasks');
    await context.close();
  }
  if (want('mention')) {
    console.log('mention');
    const { page, context } = await open();
    await page.waitForSelector('.message'); await settle(page, 800);
    await page.click('#navigation-mentions'); await settle(page, 900);
    await shot(page, 'mention');
    await context.close();
  }
  if (want('composer')) {
    console.log('composer');
    const { page, context } = await open();
    await page.waitForSelector('.message'); await settle(page, 800);
    await page.click('#messageInput'); await page.keyboard.type('@'); await settle(page, 900);
    await shot(page, 'autocomplete');
    await context.close();
  }
  if (want('voice')) {
    console.log('voice');
    const members = [USERS.mio, USERS.rin].map((u, i) => ({ memberId: 'm' + i, user: u, microphone: i === 0, publishing: i === 0 }));
    const { page, context } = await open({ voiceMembers: members });
    await page.waitForSelector('.message'); await settle(page, 1500);
    await shot(page, 'voice-roster');
    await page.click('[data-voice-toggle]').catch(e => console.log('  voice toggle:', e.message.split('\n')[0]));
    await settle(page, 900);
    await shot(page, 'voice-panel');
    await context.close();
  }
  if (want('mobile')) {
    console.log('mobile');
    const { page, context } = await open({ width: 390, height: 800, mobile: true });
    await page.waitForSelector('.message'); await settle(page, 1500);
    await shot(page, 'mobile-chat');
    await page.click('.sidebar-toggle').catch(() => {}); await settle(page, 900);
    await shot(page, 'mobile-drawer');
    await context.close();
  }
} finally {
  await browser.close();
  process.exit(0);
}
