import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const [direct, proxy] = process.argv.slice(2);
assert(direct && proxy, 'Provide isolated backend and Nginx base URLs');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [origin, prefix] of [[direct, ''], [proxy, '/backend']]) {
    for (const slash of ['', '/']) {
      const page = await browser.newPage();
      const errors = [];
      const requests = [];
      page.on('pageerror', (error) => errors.push({ name: error.name, message: error.message }));
      page.on('request', (request) => requests.push(request.url()));
      await page.addInitScript(() => {
        window.cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          window.cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
        });
      });
      const response = await page.goto(`${origin}${prefix}/api/docs${slash}`);
      assert.equal(response.status(), 200);
      const headers = await response.allHeaders();
      assert.equal(headers['x-content-type-options'], 'nosniff');
      assert.equal(headers['referrer-policy'], 'no-referrer');
      assert.equal(headers['x-frame-options'], 'DENY');
      assert.equal(headers['cache-control'], 'no-store');
      assert(headers['content-security-policy'].includes("script-src 'self'"));
      assert(!headers['content-security-policy'].includes('unsafe-'));
      try {
        await page.locator('.swagger-ui .info .title').waitFor();
      } catch (error) {
        console.error(JSON.stringify({ errors, requests, state: await page.evaluate(() => ({
          bundle: typeof window.SwaggerUIBundle,
          initialized: !!window.ui,
          violations: window.cspViolations,
          body: document.body.textContent.slice(0, 400),
        })) }));
        throw error;
      }
      await page.locator('.swagger-ui .opblock').first().waitFor();
      const legitimate = await page.evaluate(() => ({
        violations: window.cspViolations,
        sheets: [...document.styleSheets].map((sheet) => ({ href: sheet.href, rules: sheet.cssRules.length })),
        specTitle: window.ui.specSelectors.specJson().getIn(['info', 'title']),
        server: window.ui.specSelectors.specJson().getIn(['servers', 0, 'url']),
        scripts: [...document.scripts].map((script) => ({ src: script.src, inline: script.textContent.trim().length })),
      }));
      assert.deepEqual(legitimate.violations, []);
      assert.equal(legitimate.specTitle, 'Nanika API');
      assert.equal(legitimate.server, prefix || '/');
      assert(legitimate.sheets.some((sheet) => sheet.href.endsWith('/assets/swagger-ui.css') && sheet.rules > 0));
      assert(legitimate.scripts.every((script) => script.src.startsWith(origin) && script.inline === 0));
      assert(requests.every((url) => url.startsWith(origin + '/')));
      assert(requests.includes(`${origin}${prefix}/api/docs/swagger.yaml`));
      assert.deepEqual(errors, []);
      const health = await page.request.get(`${origin}${prefix}/health`);
      assert.equal(health.status(), 200);
      assert.equal(health.headers()['content-security-policy'], undefined);

      const op = page.locator('.opblock').filter({ has: page.locator('.opblock-summary-path[data-path="/health"]') });
      await op.locator('.opblock-summary').click();
      await op.getByRole('button', { name: 'Try it out' }).click();
      const executed = page.waitForResponse(`${origin}${prefix}/health`);
      await op.getByRole('button', { name: 'Execute', exact: true }).click();
      assert.equal((await executed).status(), 200);

      await page.evaluate(() => {
        const inline = document.createElement('script');
        inline.textContent = 'window.forbiddenInlineExecuted = true';
        document.head.append(inline);
        const foreign = document.createElement('script');
        foreign.src = 'https://unauthorized.example.invalid/track-a-script.js';
        document.head.append(foreign);
      });
      await page.waitForFunction(() => window.cspViolations.length >= 2);
      const blocked = await page.evaluate(() => ({ ran: !!window.forbiddenInlineExecuted, violations: window.cspViolations }));
      assert.equal(blocked.ran, false);
      assert(blocked.violations.some((v) => v.blocked === 'inline' && v.directive === 'script-src-elem'));
      assert(blocked.violations.some((v) => v.blocked.startsWith('https://unauthorized.example.invalid') && v.directive === 'script-src-elem'));
      assert.deepEqual(errors, []);
      results.push({ path: `${prefix}/api/docs${slash}`, localAssets: true, yaml: true, rendered: true, tryItOut: true, inlineBlocked: true, foreignBlocked: true, unexpectedViolations: 0 });
      await page.close();
    }
  }
  console.log(JSON.stringify({ status: 'PASS', browser: browser.version(), browserLaunches: 1, scenarios: results }));
} finally {
  await browser.close();
}
