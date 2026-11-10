const {url,artifact}=globalThis.sessionCachePage;
const fs=await import('node:fs/promises');const assert=(await import('node:assert/strict')).default;
const task=await taskSpace('会话缓存验收');const page=task.page('p1');const checks=[];
const check=(name,value)=>{checks.push({name,result:value?'PASS':'FAIL'});assert.ok(value,name)};
try {
 await page.goto(url+'/cc#/login');await fs.writeFile(artifact+'/login-snapshot.txt',await page.snapshot());
 await page.fill('input[placeholder="输入密码"]','testpass');await page.click("loc=role:button[name='登录']");await page.waitForFunction(()=>location.hash.startsWith('#/welcome'));
 const dismissed=await page.evaluate(async()=>{const r=await fetch('/api/panel/onboarding',{method:'PUT',headers:{'content-type':'application/json',Authorization:'Bearer '+localStorage.getItem('kin_console_token')},body:JSON.stringify({action:'dismiss'})});return r.status});assert.equal(dismissed,200);
 await page.goto(url+'/cc?e2e=session-cache#/logs');await page.waitForSelector('loc=css:div[role="button"]:has-text("cache-page-model")');await fs.writeFile(artifact+'/logs-snapshot.txt',await page.snapshot());
 await page.click('loc=css:div[role="button"]:has-text("cache-page-model")');await page.waitForSelector('[role="dialog"]');await fs.writeFile(artifact+'/detail-snapshot.txt',await page.snapshot());
 await page.click("loc=role:tab[name='会话缓存']");await page.waitForSelector('text=fixture-generation');
 const text=await page.evaluate(()=>document.querySelector('[role="dialog"]').textContent);
 check('branch_groups_visible',text.includes('会话分支')&&text.includes('自动模式分类'));
 check('actual_usage_visible',text.includes('50,000')&&text.includes('300'));
 check('prefix_append_and_unknown_parent',text.includes('追加历史')&&text.includes('未知；请求未提供'));
 check('bounded_window_explained',text.includes('128')&&text.includes('不是会话累计用量'));
 check('request_correlation_opens_selected',await page.evaluate(()=>!![...document.querySelectorAll('details[open]')].find(n=>n.textContent.includes('native-main'))));
 await page.click('text=自动模式分类 · s-2');const expanded=await page.evaluate(()=>document.querySelector('[role="dialog"]').textContent);
 check('missing_data_is_unknown',expanded.includes('没有原生前缀观测')&&expanded.includes('响应未确认完整'));
 await page.click("loc=role:button[name='刷新']");await page.waitForSelector('text=fixture-generation');
 await fs.writeFile(artifact+'/final-snapshot.txt',await page.snapshot({scope:'full_page'}));await page.screenshot({path:artifact+'/session-cache.png'});
 await fs.writeFile(artifact+'/summary.json',JSON.stringify({result:'PASS',checks,synthetic_only:true},null,2)+'\n');
 await task.finish({keep:[]});
} catch(error) {await fs.writeFile(artifact+'/summary.json',JSON.stringify({result:'FAIL',checks,error:String(error)},null,2)+'\n');console.log(await page.snapshot());throw error;}
