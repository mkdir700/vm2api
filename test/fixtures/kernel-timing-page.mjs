const { url, artifact } = globalThis.kernelTimingPage;
const fs = await import("node:fs/promises");
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace("内核耗时性能页验收");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
const checks = [];
const check = (name, ok) => {
  checks.push({ name, result: ok ? "PASS" : "FAIL" });
  assert.ok(ok, name);
};
try {
  await page.goto(url + "/cc#/login");
  await fs.writeFile(artifact + "/login-snapshot.txt", await page.snapshot());
  await page.fill('input[placeholder="输入密码"]', "testpass");
  await page.click("loc=role:button[name='登录']");
  await page.waitForFunction(() => location.hash.startsWith("#/welcome"));
  await page.evaluate(async () => {
    await fetch("/api/panel/onboarding", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer " + localStorage.getItem("kin_console_token"),
      },
      body: JSON.stringify({ action: "dismiss" }),
    });
  });
  await page.goto(url + "/cc?e2e=kernel-timing#/logs");
  await page.waitForSelector(
    'loc=css:div[role="button"]:has-text("claude-haiku") >> nth=5',
  );
  await fs.writeFile(
    artifact + "/logs-snapshot.txt",
    await page.snapshot({ scope: "full_page" }),
  );
  if (
    await page.evaluate(
      () => !!document.querySelector('button[aria-label="关闭提示"]'),
    )
  )
    await page.click('button[aria-label="关闭提示"]');
  await page.click(
    'loc=css:div[role="button"]:has-text("claude-haiku") >> nth=5',
  );
  await page.waitForSelector('[role="dialog"]');
  await fs.writeFile(artifact + "/detail-snapshot.txt", await page.snapshot());
  await page.click("loc=role:tab[name='性能']");
  await page.waitForSelector('[data-testid="kernel-timing"]');
  const text = await page.evaluate(
    () => document.querySelector('[data-testid="kernel-timing"]').textContent,
  );
  check(
    "declared_timing_visible",
    text.includes("内核耗时明细") && text.includes("复用会话"),
  );
  check("zero_stage_visible", text.includes("内核会话获取"));
  check(
    "known_upstream_points_visible",
    text.includes("收到首个协议事件") && text.includes("上游响应完成"),
  );
  check("missing_content_point_hidden", !text.includes("收到首个内容"));
  check("overlap_explained", text.includes("不能相加"));
  await fs.writeFile(
    artifact + "/performance-snapshot.txt",
    await page.snapshot({ scope: "full_page" }),
  );
  await page.screenshot({ path: artifact + "/performance.png" });
  await page.keyboard.press("Escape");
  await page.click(
    'loc=css:div[role="button"]:has-text("claude-haiku") >> nth=0',
  );
  await page.waitForSelector('[role="dialog"]');
  await page.click("loc=role:tab[name='性能']");
  check(
    "unsupported_timing_hidden",
    await page.evaluate(
      () => document.querySelector('[data-testid="kernel-timing"]') === null,
    ),
  );
  await fs.writeFile(
    artifact + "/unsupported-snapshot.txt",
    await page.snapshot({ scope: "full_page" }),
  );
  await fs.writeFile(
    artifact + "/browser-summary.json",
    JSON.stringify({ result: "PASS", checks }, null, 2),
  );
  await task.finish({ keep: [] });
} catch (error) {
  await fs.writeFile(
    artifact + "/browser-summary.json",
    JSON.stringify({ result: "FAIL", checks, error: String(error) }, null, 2),
  );
  console.log(await page.snapshot());
  throw error;
}
