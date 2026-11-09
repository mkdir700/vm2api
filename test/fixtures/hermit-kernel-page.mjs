// Run through ego-browser nodejs. The E2E runner injects an isolated URL and output directory.
const { url, artifact, archive, receipt, productionArchive, productionReceipt } = globalThis.hermitKernelPage;
const fs = await import('node:fs/promises');
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('Hermit 内核行验收');
const page = task.page('p1');
const checks = [];
const check = (name, value) => {
  checks.push({ name, result: value ? 'PASS' : 'FAIL' });
  assert.ok(value, name);
};
try {
  await page.goto(url + '/cc#/login');
  await page.fill('input[placeholder="输入密码"]', 'testpass');
  await page.click("loc=role:button[name='登录']");
  await page.waitForFunction(() => location.hash.startsWith('#/welcome'));
  const setup = await page.fetch('/api/panel/onboarding', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }),
  });
  assert.equal(setup.status, 200);
  await page.goto(url + '/cc?e2e=wrap#/wrap');
  await page.waitForSelector('section[aria-label="可用内核"]');
  check('three_peer_kernel_rows', await page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="可用内核"] h3')].map(n => n.textContent).join(',') === 'cli-node,CRAG,Hermit'));
  check('hermit_pull_disabled', await page.evaluate(() => document.querySelector('button[aria-label="拉取 Hermit 最新内核包"]').disabled));
  check('no_standalone_upload_form', await page.evaluate(() => !document.querySelector('input[type="file"]')));
  await page.screenshot({ path: artifact + '/kernels-desktop.png' });
  await page.evaluate(() => {
    const original = window.fetch;
    window.uploadResponses = [];
    window.fetch = async (...args) => {
      const result = await original(...args);
      if (String(args[0]).endsWith('/api/panel/kernel-packages') && args[1]?.method === 'POST') window.uploadResponses.push({ status: result.status, body: await result.clone().text() });
      return result;
    };
  });
  await page.click("loc=role:button[name='上传内核包']");
  await page.waitForSelector('[role="dialog"]');
  check('upload_requires_both_files', await page.evaluate(() => [...document.querySelectorAll('button')].find(n => n.textContent.trim() === '更新内核包').disabled));
  await page.setInputFiles('input[aria-label="Hermit 版本归档"]', [archive]);
  check('archive_alone_is_insufficient', await page.evaluate(() => [...document.querySelectorAll('button')].find(n => n.textContent.trim() === '更新内核包').disabled));
  await page.setInputFiles('input[aria-label="Hermit 发布清单"]', [receipt]);
  await page.click("loc=role:button[name='更新内核包']");
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('0.1.0-ui-e2e'));
  check('uploaded_version_visible', true);
  check('package_dialog_has_no_slot_actions', await page.evaluate(() => {
    const text = document.querySelector('[role="dialog"]').textContent;
    return !text.includes('暂存到所选槽位') && !text.includes('切换并应用');
  }));
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(n => n.textContent.trim() === '更新内核包').disabled);
  await page.setInputFiles('input[aria-label="Hermit 版本归档"]', []);
  await page.setInputFiles('input[aria-label="Hermit 发布清单"]', []);
  await page.setInputFiles('input[aria-label="Hermit 版本归档"]', [productionArchive]);
  await page.setInputFiles('input[aria-label="Hermit 发布清单"]', [productionReceipt]);
  await page.click("loc=role:button[name='更新内核包']");
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('0.2.0-ui-e2e'));
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check('dialog_fits_narrow_screen', await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const r = d.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && d.scrollWidth <= d.clientWidth;
  }));
  await page.screenshot({ path: artifact + '/upload-mobile.png' });
  await page.press('[role="dialog"]', 'Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'hidden' });
  check('row_refreshes_after_upload', await page.evaluate(() => document.querySelector('section[aria-label="可用内核"]').textContent.includes('0.2.0-ui-e2e')));
  await page.click('button[aria-label="关闭提示"]');
  await page.click('button[aria-label="sim-01 安装内核"]');
  await page.click("loc=role:option[name='Hermit']");
  check('no_hermit_version_selector', await page.evaluate(() => !document.querySelector('button[aria-label="sim-01 Hermit 版本"]')));
  check('current_package_displayed', await page.evaluate(() => document.body.textContent.includes('0.2.0-ui-e2e')));
  await page.screenshot({ path: artifact + '/vm-install-mobile.png' });
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  await page.screenshot({ path: artifact + '/vm-install-desktop.png' });
  await page.click("loc=role:button[name='全部重装并停用 · 1 台']");
  check('batch_confirmation_carries_version', await page.evaluate(() => document.querySelector('[role="alertdialog"]').textContent.includes('Hermit · 0.2.0-ui-e2e')));
  await page.click("loc=role:button[name='取消']");
  await page.evaluate(() => {
    const original = window.fetch;
    window.installRequests = [];
    window.installResponses = [];
    window.fetch = async (...args) => {
      if (String(args[0]).endsWith('/api/panel/kernels/install')) window.installRequests.push(JSON.parse(args[1].body));
      const result = await original(...args);
      if (String(args[0]).endsWith('/api/panel/kernels/install')) window.installResponses.push(await result.clone().json());
      return result;
    };
  });
  await page.click('button[aria-label="安装 sim-01 并停用"]');
  await page.click("loc=role:button[name='重装并停用']");
  await page.waitForFunction(() => window.installRequests.length === 1 && window.installResponses.length === 1);
  const response = await page.evaluate(() => window.installResponses[0]);
  check('isolated_browser_environment_refuses_activation', ['kernel_transition_placement_unsupported', 'proxy_required'].includes(response.data?.items?.[0]?.code));
  const requests = await page.evaluate(() => window.installRequests);
  check('shared_install_endpoint_receives_exact_version', JSON.stringify(requests[0].targets) === JSON.stringify([{ id: 'vm-sim-01', kernel: 'hermit', manifest_sha256: JSON.parse(await fs.readFile(productionReceipt, 'utf8')).manifest_sha256 }]));
  await fs.writeFile(artifact + '/install-requests.json', JSON.stringify(requests, null, 2));
  await fs.writeFile(artifact + '/page.txt', await page.snapshot({ scope: 'full_page' }));
  await task.finish({ keep: [] });
} catch (error) {
  await fs.writeFile(artifact + '/upload-responses.json', JSON.stringify(await page.evaluate(() => window.uploadResponses), null, 2));
  await fs.writeFile(artifact + '/failed-page.txt', await page.snapshot({ scope: 'full_page' }));
  throw error;
} finally {
  await fs.writeFile(artifact + '/checks.json', JSON.stringify(checks, null, 2));
}
