// Uses only its own disposable container; accepts an image, never a target URL.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {verifyHandlers} from './handlers.mjs';
import {openDialog, closeDialog, verifyMemberDialogs, verifyRiskGuides} from './dialogs.mjs';
const image = process.argv[2] || 'zerotier-planet:ci-test';
if (image.startsWith('-') || image.includes('://')) throw new Error('Expected a local Docker image tag');
// Documentation-only IPv6: test configuration/rendering without a public peer.
const rootIPv6 = '2001:db8:abcd:1234:5678:90ab:cdef:1234';
const name = 'planet-browser-' + randomUUID();
const network = name + '-net';
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8', timeout:60000, stdio:['ignore','pipe','pipe']}).trim();
let browser, createdNetwork = false, createdContainer = false;
const pass = text => console.log('PASS: ' + text);
try {
  docker('network','create',network); createdNetwork = true;
  docker('create','--pull','never','--cpus','2','--memory','2g','--memory-swap','2g','--pids-limit','256','--name',name,'--network',network,'-p','127.0.0.1::3443',
    '-e','IP_ADDR4=','-e','IP_ADDR6='+rootIPv6,'-e','HTTP_HOST=0.0.0.0',
    '-v','/var/lib/zerotier-one','-v','/app/config','-v','/app/dist','-v','/var/lib/ztncui',image);
  createdContainer = true; docker('start',name);
  await verifyHandlers(docker('exec',name,'cat','/opt/ztncui/src/controllers/networkController.js'));
  const binding = JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['3443/tcp'][0];
  assert.equal(binding.HostIp,'127.0.0.1');
  const base = 'http://127.0.0.1:' + binding.HostPort;
  let ready = false;
  for(let i=0;i<90;i++) {
    try {if ((await fetch(base+'/login',{signal:AbortSignal.timeout(1500)})).ok) {ready=true;break;}} catch {}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(ready,'disposable UI must start');
  browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  const context = await browser.newContext({viewport:{width:1365,height:900}});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  const overflowDir = process.env.PLANET_BROWSER_SCREENSHOT_DIR || '/tmp';
  async function assertNoPageOverflow(label) {
    const report = await page.evaluate(() => {
      const width = window.innerWidth;
      const nodes = [...document.querySelectorAll('body *')].map(node => {
        const rect = node.getBoundingClientRect();
        return {node, rect, right: rect.right, left: rect.left};
      }).filter(item => item.rect.width > 0 && (item.right > width + 1 || item.left < -1))
        .sort((a, b) => Math.max(b.right - width, -b.left) - Math.max(a.right - width, -a.left))
        .slice(0, 12)
        .map(item => ({tag: item.node.tagName, id: item.node.id, className: item.node.className,
          left: Math.round(item.left), right: Math.round(item.right), width: Math.round(item.rect.width),
          text: (item.node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100)}));
      return {innerWidth: width, scrollWidth: document.documentElement.scrollWidth, nodes};
    });
    if (report.scrollWidth > report.innerWidth) {
      const file = join(overflowDir, `overflow-${randomUUID()}.png`);
      try { await page.screenshot({path: file, fullPage: true}); } catch {}
      assert.fail(`${label} page overflow: ${JSON.stringify({...report, screenshot: file})}`);
    }
  }
  // Public entry and sign-in should explain one task, without repeated branding.
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const route of ['/', '/login']) {
      for (const lang of ['en', 'zh-CN']) {
        await page.goto(base + route + '?lang=' + lang);
        assert.equal(await page.locator('html').getAttribute('lang'), lang);
        assert.equal(await page.locator('.auth-brand').count(), 1);
        const text = await page.locator('body').innerText();
        assert.equal((text.match(/ZeroTier Planet/g) || []).length, 1, 'brand appears once');
        assert.equal(await page.locator('.auth-heading h1').count(), 1);
        assert.equal(await page.locator('.auth-heading p').count(), 1);
        assert.equal(await page.locator('.auth-story, .auth-points, .auth-card-footer').count(), 0, 'no repeated marketing blocks');
        assert.ok(!text.includes('清爽、可控的私有网络。'));
        assert.ok(!text.includes('为自托管 ZeroTier 优化'));
        await assertNoPageOverflow(`public ${route} ${lang} at ${width}px`);
      }
    }
  }
  pass('public entry and login show one brand and concise copy in both languages at 360/390/768/1440px');
  await page.goto(base+'/login?lang=en');
  assert.deepEqual(await page.evaluate(() => ({
    collapse: typeof window.jQuery.fn.collapse,
    tooltip: typeof window.jQuery.fn.tooltip,
    popover: typeof window.jQuery.fn.popover
  })), {collapse: 'function', tooltip: 'undefined', popover: 'undefined'});
  assert.equal((await page.request.get(base+'/bsjs/bootstrap.min.js')).status(), 404);
  pass('console loads only the required Bootstrap navigation plugins');
  await page.locator('#username').fill('admin'); await page.locator('#password').fill('password');
  await page.locator('button[type=submit]').click();
  if (/\/users\/admin\/password$/.test(page.url())) {
    await page.locator('#password1').fill('BrowserRegressionPassword123!');
    await page.locator('#password2').fill('BrowserRegressionPassword123!');
    await page.locator('button[type=submit]').click();
  }
  await page.goto(base+'/controller');
  const screenshotDir = process.env.PLANET_BROWSER_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, {recursive: true});
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const route of ['/controller', '/controller/monitor']) {
      await page.goto(base + route + '?lang=en');
      for (const lang of ['en', 'zh-CN']) {
        if (lang === 'zh-CN') {
          // Exercise the actual navigation and persisted language preference.
          if (await page.locator('.navbar-toggle').isVisible()) {
            await page.locator('.navbar-toggle').click();
            await page.locator('#appNavigation.in').waitFor({state:'visible'});
          }
          await page.locator('.language-menu a').click();
          await page.waitForURL('**?lang=zh-CN');
        }
        assert.equal(new URL(page.url()).pathname, route);
        assert.equal(await page.locator('html').getAttribute('lang'), lang);
        const panel = page.locator('#root-topology');
        await panel.waitFor({state:'visible'});
        if (route === '/controller') {
          assert.equal(await panel.locator('.monitor-endpoint-row').count(), 0, 'home keeps Root details in monitoring');
          assert.equal(await panel.locator('.root-monitor-link').getAttribute('href'), '/controller/monitor#root-topology');
          assert.equal(await page.locator('.dashboard-stat-grid .stat-card').count(), 3, 'home shows three focused network metrics');
          assert.equal(await page.locator('.dashboard-action-grid .action-card').count(), 4);
          assert.equal(await page.locator('.dashboard-management').getAttribute('open'), null, 'administration is collapsed initially');
        } else {
          const disclosure = panel.locator('details.root-diagnostics');
          assert.equal(await disclosure.getAttribute('open'), null, 'Root detail starts collapsed');
          const dialog = await openDialog(page, disclosure);
          const endpoint = dialog.locator('.monitor-endpoint-row code');
          assert.deepEqual(await endpoint.allTextContents(), [rootIPv6+'/9994'], 'full IPv6 stable endpoint must survive rendering');
          const text = await panel.innerText() + await dialog.innerText();
          assert.ok(text.includes(lang === 'en' ? 'NO STABLE ENDPOINT' : '未配置稳定端点'));
          assert.ok(text.includes(lang === 'en' ? 'EXTERNAL PATH UNVERIFIED' : '外部可达性未验证'));
          assert.ok(text.includes(lang === 'en' ? 'does not prove public IPv4 / IPv6 reachability' : '本机运行不证明公网 IPv4 / IPv6 可达'));
          assert.ok(await dialog.locator('.monitor-root-item').evaluateAll(cards => cards.every(card => {
            const bounds = card.getBoundingClientRect();
            return card.scrollWidth <= card.clientWidth && [...card.querySelectorAll('code, .path-badge')].every(node => {
              const rect = node.getBoundingClientRect();
              return rect.left >= bounds.left && rect.right <= bounds.right + 1 && node.scrollWidth <= node.clientWidth + 1;
            });
          })), `${route} ${lang} at ${width}px must contain complete Root content`);
        }
        await assertNoPageOverflow(`${route} ${lang} at ${width}px`);
        if (screenshotDir) await page.screenshot({path:join(screenshotDir, `root-${route.endsWith('monitor') ? 'monitor' : 'home'}-${lang}-${width}.png`), fullPage:route !== '/controller/monitor'});
        if (route === '/controller/monitor') await closeDialog(page, panel.locator('details.root-diagnostics'));
      }
    }
  }
  pass('IPv6-only generated Root: full endpoints, neutral unconfigured IPv4, local reachability caveat, bilingual home/monitor at 360/390/768/1440px');
  await page.setViewportSize({width:1365,height:900});
  await page.goto(base+'/controller?lang=en');
  await page.goto(base+'/controller/network/create'); await page.locator('#name').fill('Browser regression');
  await Promise.all([page.waitForURL(/\/network\/[a-f0-9]{16}$/),page.locator('button[type=submit]').click()]);
  const detail = page.url(); const nwid = detail.split('/').at(-1);
  await page.goto(detail+'/easy');
  await page.locator('#networkCIDR').fill('10.88.99.0/24'); await page.locator('#networkCIDR').press('Tab');
  await Promise.all([page.waitForNavigation(),page.locator('button[type=submit]').click()]);
  await page.reload(); assert.equal(await page.locator('#poolStart').inputValue(),'10.88.99.1');
  assert.equal(await page.locator('#poolEnd').inputValue(),'10.88.99.254');
  for(const [cidr,start,end] of [['10.0.0.0/31','10.0.0.1','10.0.0.2'],['10.0.0.0/24.5','10.0.0.1','10.0.0.2'],['10.0.0.0/24','10.0.0.5','10.0.0.2']]) {
    await page.locator('#networkCIDR').fill(cidr); await page.locator('#networkCIDR').press('Tab');
    await page.locator('#poolStart').fill(start); await page.locator('#poolEnd').fill(end);
    let posts=0;const listener=req=>{if(req.method()==='POST')posts++;};page.on('request',listener);
    await page.locator('button[type=submit]').click(); await page.waitForTimeout(150);page.off('request',listener);
    assert.equal(posts,0,'invalid form must not submit');
    const response=await context.request.post(detail+'/easy',{form:{networkCIDR:cidr,poolStart:start,poolEnd:end}});
    assert.equal(response.status(),400,'direct invalid request must be rejected');
  }
  pass('login, create network, easy setup persistence, browser and HTTP validation');
  await page.goto(detail);
  let renamePosts=0;page.on('request',req=>{if(req.method()==='POST'&&req.url()===detail+'/name')renamePosts++;});
  await page.locator('#change-name').click();await page.locator('#name-input').fill('Cancelled');await page.locator('#name-input').press('Escape');
  await page.waitForTimeout(150);assert.equal(renamePosts,0);await page.reload();assert.equal(await page.locator('#name').textContent(),'Browser regression');
  await page.locator('#change-name').click();await page.locator('#name-input').fill('Renamed');
  await Promise.all([page.waitForResponse(r=>r.url()===detail+'/name'),page.locator('#name-input').press('Enter')]);
  await page.locator('#name-input').waitFor({state:'hidden'});assert.equal(renamePosts,1);
  await page.route('**/network/'+nwid+'/name',route=>route.fulfill({status:503,body:'Injected failure'}));
  await page.locator('#change-name').click();await page.locator('#name-input').fill('Retry preserved');await page.locator('#name-input').press('Enter');
  await page.locator('#name-error').waitFor({state:'visible'});assert.equal(await page.locator('#name-input').inputValue(),'Retry preserved');
  await page.unroute('**/network/'+nwid+'/name');await page.locator('#name-input').press('Enter');await page.locator('#name-input').waitFor({state:'hidden'});
  await page.reload();assert.equal(await page.locator('#name').textContent(),'Retry preserved');
  const invalidRename = await context.request.post(detail+'/name', {form:{name:''}});
  assert.equal(invalidRename.status(),400,'rename validation must reject empty names');
  pass('rename Escape sends nothing, Enter sends once, failed save retains text and retries; backend rejects invalid rename');
  await page.locator('.language-menu a').click();await page.waitForURL('**?lang=zh-CN');
  assert.equal(new URL(page.url()).pathname,new URL(detail).pathname);await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  assert.ok((await context.cookies()).some(cookie=>cookie.value==='zh-CN'));
  await page.locator('.language-menu a').click();await page.waitForURL('**?lang=en');await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  pass('language links, cookies and reload preserve network route');
  // Fixture is created only through the private API inside this test's own container.
  const member='aabbccddee';
  docker('exec',name,'node','-e',`const fs=require('fs');fetch('http://127.0.0.1:'+fs.readFileSync('/var/lib/zerotier-one/zerotier-one.port','utf8').trim()+'/controller/network/${nwid}/member/${member}',{method:'POST',headers:{'X-ZT1-AUTH':fs.readFileSync('/var/lib/zerotier-one/authtoken.secret','utf8').trim(),'Content-Type':'application/json'},body:JSON.stringify({authorized:false,name:'Fixture'})}).then(r=>{if(!r.ok)process.exit(1)})`);
  await page.goto(detail);
  const auth=page.locator('.authCheck[value="'+member+'"]');const memberName=page.locator('.member-name-input[name="'+member+'"]');
  const authResponse = page.waitForResponse(r=>r.url()===detail+'/members' && r.request().method()==='POST');
  await auth.check({force:true});assert.equal((await authResponse).status(),204);await page.waitForFunction(id=>!document.querySelector('.authCheck[value="'+id+'"]').disabled,member);
  await memberName.fill('Browser member');await memberName.press('Tab');await page.waitForFunction(id=>!document.querySelector('.member-name-input[name="'+id+'"]').disabled,member);
  await page.reload();assert.equal(await auth.isChecked(),true);assert.equal(await memberName.inputValue(),'Browser member');
  await memberName.fill('');await memberName.press('Tab');await page.waitForFunction(id=>!document.querySelector('.member-name-input[name="'+id+'"]').disabled,member);
  await page.reload();assert.equal(await memberName.inputValue(),'','cleared member name must persist');
  await page.route('**/network/'+nwid+'/members',route=>route.fulfill({status:503,body:'Injected failure'}));
  await auth.uncheck({force:true});await page.locator('#members-save-status.is-error').waitFor({state:'visible'});assert.equal(await auth.isChecked(),true);
  await page.unroute('**/network/'+nwid+'/members');
  pass('member authorization/name survive reload, failed authorization rolls back with visible feedback');
  // Populate only the disposable container's authenticated loopback controller API.
  docker('exec', name, 'node', '-e', `
    const fs = require('fs');
    const base = 'http://127.0.0.1:' + fs.readFileSync('/var/lib/zerotier-one/zerotier-one.port', 'utf8').trim();
    const headers = {'X-ZT1-AUTH': fs.readFileSync('/var/lib/zerotier-one/authtoken.secret', 'utf8').trim(), 'Content-Type': 'application/json'};
    async function post(path, value) {
      const response = await fetch(base + path, {method: 'POST', headers, body: JSON.stringify(value)});
      if (!response.ok) throw new Error('Fixture failed: ' + response.status);
    }
    (async () => {
      for (let i = 1; i <= 11; i++) {
        await post('/controller/network/${nwid.slice(0, 10)}' + i.toString(16).padStart(6, '0'), {name: 'Pagination network ' + i, private: true});
        await post('/controller/network/${nwid}/member/' + ('bb' + i.toString(16).padStart(8, '0')), {authorized: false, activeBridge: i === 1, name: 'Pagination member ' + i, ipAssignments: ['10.88.99.' + (100 + i)]});
      }
    })().catch(error => {console.error(error.message); process.exitCode = 1;});
  `);
  async function checkPagination(list, label) {
    assert.equal(await list.locator('[data-list-row]').count(), 12, label + ' has real persisted fixtures');
    assert.equal(await list.locator('[data-list-row]:visible').count(), 10, label + ' first page');
    await list.locator('[data-list-next]').click();
    assert.equal(await list.locator('[data-list-row]:visible').count(), 2, label + ' second page');
    assert.equal(await list.locator('[data-list-next]').isDisabled(), true);
    await list.locator('[data-list-search]').fill('nonexistent-pagination-result');
    assert.equal(await list.locator('[data-list-row]:visible').count(), 0);
    assert.equal(await list.locator('[data-list-empty]').isVisible(), true);
    assert.equal(await list.locator('[data-list-prev]').isDisabled(), true);
    await list.locator('[data-list-search]').fill('');
    assert.equal(await list.locator('[data-list-row]:visible').count(), 10, 'clearing search resets to page one');
    await list.locator('[data-list-next]').click();
  }
  for (const lang of ['en', 'zh-CN']) {
    await page.goto(base + '/controller/networks?lang=' + lang);
    await checkPagination(page.locator('.network-list-card'), 'networks ' + lang);
    await page.goto(detail + '?lang=' + lang);
    await checkPagination(page.locator('#members'), 'members ' + lang);
    await page.goto(base + '/controller/monitor?lang=' + lang);
    await checkPagination(page.locator('#network-health'), 'monitor networks ' + lang);
    await checkPagination(page.locator('#member-paths'), 'monitor members ' + lang);
  }
  await page.goto(detail + '?lang=en');
  const memberList = page.locator('#members');
  await memberList.locator('[data-list-next]').click();
  const secondPageName = memberList.locator('[data-list-row]:visible .member-name-input').first();
  const secondPageId = await secondPageName.getAttribute('name');
  const previousMemberAlias = await secondPageName.inputValue();
  await secondPageName.fill('Saved from second page');
  const secondPageSave = page.waitForResponse(r => r.url() === detail + '/members' && r.request().method() === 'POST');
  await secondPageName.press('Tab');
  assert.equal((await secondPageSave).status(), 204);
  await page.waitForTimeout(100);
  if (previousMemberAlias.trim()) {
    await memberList.locator('[data-list-search]').fill(previousMemberAlias);
    assert.equal(await memberList.locator('.member-name-input[name="' + secondPageId + '"]').isVisible(), false, 'replaced alias stops matching without a reload');
  }
  await memberList.locator('[data-list-search]').fill('Saved from second page');
  assert.equal(await memberList.locator('[data-list-row]:visible').count(), 1, 'new alias is searchable immediately');
  await page.reload();
  await memberList.locator('[data-list-search]').fill(secondPageId);
  assert.equal(await memberList.locator('[data-list-row]:visible').count(), 1);
  assert.equal(await memberList.locator('.member-name-input[name="' + secondPageId + '"]').inputValue(), 'Saved from second page');
  await page.goto(base + '/controller/networks?lang=en');
  const networkList = page.locator('.network-list-card');
  await networkList.locator('[data-list-next]').click();
  const secondNetworkLink = networkList.locator('[data-list-row]:visible a[href^="/controller/network/"]').first();
  const secondNetworkPath = await secondNetworkLink.getAttribute('href');
  await secondNetworkLink.click();
  await page.locator('#change-name').click();
  await page.locator('#name-input').fill('Network saved from second page');
  const secondNetworkSave = page.waitForResponse(r => r.url() === base + secondNetworkPath + '/name' && r.request().method() === 'POST');
  await page.locator('#name-input').press('Enter');
  assert.equal((await secondNetworkSave).status(), 302, 'second-page network rename redirects after save');
  await page.locator('#name-input').waitFor({state: 'hidden'});
  await page.goto(base + '/controller/networks');
  await networkList.locator('[data-list-search]').fill('Network saved from second page');
  assert.equal(await networkList.locator('[data-list-row]:visible').count(), 1);
  assert.equal(await networkList.locator('[data-list-row]:visible a[href^="/controller/network/"]').first().getAttribute('href'), secondNetworkPath);
  await networkList.locator('[data-list-search]').fill(secondNetworkPath.split('/').pop());
  assert.equal(await networkList.locator('[data-list-row]:visible').count(), 1, 'network ID search matches');
  await page.goto(detail + '?lang=en');
  const memberSearch = memberList.locator('[data-list-search]');
  await memberSearch.fill('Saved from second page');
  assert.equal(await memberList.locator('[data-list-row]:visible').count(), 1, 'member alias search matches');
  await memberSearch.fill(previousMemberAlias);
  assert.equal(await memberList.locator('.member-name-input[name="' + secondPageId + '"]').isVisible(), false, 'replaced alias must not match the renamed member');
  await memberSearch.fill('10.88.99.101');
  assert.equal(await memberList.locator('[data-list-row]:visible').count(), 1, 'assigned IP search matches');
  assert.equal(await memberList.locator('[data-list-row]:visible .member-name-input').getAttribute('name'), 'bb00000001');
  const settings = page.locator('#network-settings');
  await openDialog(page, settings, page.locator('a[href="#network-settings"]'));
  assert.equal(await page.locator('#network-settings-dialog .config-grid').isVisible(), true);
  await closeDialog(page, settings, page.locator('a[href="#network-settings"]'));
  await settings.locator('summary').focus();
  await settings.locator('summary').press('Enter');
  await page.locator('#network-settings-dialog').waitFor({state: 'visible'});
  await closeDialog(page, settings);
  await verifyMemberDialogs({page, detail, member: 'bb00000001', screenshotDir});
  await verifyRiskGuides({page, base, screenshotDir});
  const noJs = await browser.newContext({javaScriptEnabled: false, storageState: await context.storageState(), viewport: {width: 390, height: 844}});
  try {
    const noJsPage = await noJs.newPage();
    await noJsPage.goto(base + '/controller/networks?lang=en');
    assert.equal(await noJsPage.locator('[data-list-row]:visible').count(), 12, 'no-JS network list keeps all rows visible');
    await noJsPage.goto(detail + '?lang=en');
    assert.equal(await noJsPage.locator('#members [data-list-row]:visible').count(), 12, 'no-JS member list keeps all rows visible');
    await noJsPage.locator('#member-info-bb00000001 summary').click();
    assert.equal(await noJsPage.locator('#member-info-bb00000001 .member-quick-body').isVisible(), true, 'native member details remain usable without JS');
    await noJsPage.locator('#network-settings summary').click();
    assert.equal(await noJsPage.locator('#network-settings .config-grid').isVisible(), true, 'native settings remain usable without JS');
  } finally { await noJs.close(); }
  pass('12 real networks/members: bilingual search, empty results, pagination, monitor lists and second-page edits persist');
  await page.setViewportSize({width:390,height:844});await page.reload();
  await page.locator('.navbar-toggle').click();await page.locator('#appNavigation.in').waitFor({state:'visible'});
  await page.locator('#appNavigation a[href="/controller/networks"]').click();await page.waitForURL('**/controller/networks');
  for(const url of [base+'/controller/networks',detail,detail+'/easy']) {
    await page.goto(url);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no page overflow: '+url);
  }
  assert.deepEqual(errors,[],'browser scripts must not throw');pass('390px navigation and network pages have no horizontal page overflow');
  console.log('Resource sample: '+docker('stats','--no-stream','--format','CPU={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}',name));
} finally {
  try {
    if(browser) await browser.close();
  } finally {
    try {
      if(createdContainer) docker('rm','-f','-v',name);
    } finally {
      if(createdNetwork) docker('network','rm',network);
    }
  }
}
