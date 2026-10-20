import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
const profile=await mkdtemp(path.join(os.tmpdir(),'shinian-visual-'));
const app=await electron.launch({executablePath:path.join(process.cwd(),'node_modules/electron/dist/electron'),args:['--no-sandbox','--disable-gpu',`--user-data-dir=${profile}`,'.'],cwd:process.cwd(),env:{...process.env,DISPLAY:process.env.DISPLAY||':91'}});
try{
 const page=await app.firstWindow();await page.waitForSelector('.app-shell');await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:'test-results/final-empty.png'});
 await page.getByRole('button',{name:/先逛逛示例空间/}).click();await page.getByRole('article').first().waitFor();
 await page.waitForTimeout(350);await page.locator('.toast-close').all().then(bs=>Promise.all(bs.map(b=>b.click().catch(()=>{}))));
 await page.evaluate(()=>document.querySelector('.workspace-scroll').scrollTo({top:0}));
 await page.screenshot({path:'test-results/final-cards.png'});
 await page.getByRole('button',{name:'看板视图',exact:true}).click();await page.waitForTimeout(250);
 await page.screenshot({path:'test-results/final-board.png'});
 await page.getByRole('button',{name:'卡片视图',exact:true}).click();await page.getByRole('article').first().click();await page.waitForTimeout(250);
 await page.screenshot({path:'test-results/final-editor.png'});
 await page.getByRole('button',{name:'完成编辑',exact:true}).click();
 await page.getByRole('button',{name:'切换深色模式',exact:true}).click();await page.waitForTimeout(300);
 const color=await page.locator('h1').first().evaluate(e=>getComputedStyle(e).color);assert.equal(color,'rgb(226, 231, 241)');
 await page.evaluate(()=>document.querySelector('.workspace-scroll').scrollTo({top:0}));await page.screenshot({path:'test-results/final-dark.png'});
 await page.getByRole('article').first().click();await page.waitForTimeout(200);await page.screenshot({path:'test-results/final-editor-dark.png'});await page.getByRole('button',{name:'完成编辑',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.screenshot({path:'test-results/final-settings.png'});await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
 const winPromise=app.waitForEvent('window');await page.evaluate(()=>window.shinian.openQuickCapture());const quick=await winPromise;await quick.waitForSelector('.quick-app');await quick.evaluate(()=>document.fonts.ready);await quick.waitForTimeout(150);await quick.screenshot({path:'test-results/final-quick-dark.png'});
 await page.evaluate(()=>window.shinian.dispatch({type:'settings.update',patch:{theme:'light'}}));await quick.waitForTimeout(200);await quick.screenshot({path:'test-results/final-quick-light.png'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('quick=1')).hide());

 const checkSidebar=async()=>{const geometry=await page.evaluate(()=>{const footer=document.querySelector('.sidebar-bottom').getBoundingClientRect();const projects=document.querySelector('.project-list').getBoundingClientRect();return {height:innerHeight,footerTop:footer.top,footerBottom:footer.bottom,projectsTop:projects.top,projectsBottom:projects.bottom};});assert(geometry.footerBottom<=geometry.height&&geometry.footerTop>=0,'settings and save status remain visible');assert(geometry.projectsBottom<=geometry.footerTop,'project list does not cover footer');assert(geometry.projectsBottom-geometry.projectsTop>=44,'at least one complete category remains accessible');};
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('quick=1')).setSize(920,700));await page.waitForTimeout(200);await checkSidebar();await page.screenshot({path:'test-results/final-small.png'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('quick=1')).setSize(900,640));await page.waitForTimeout(200);await checkSidebar();await page.screenshot({path:'test-results/final-minimum.png'});
 for(let i=1;i<=24;i++)await page.evaluate(n=>window.shinian.dispatch({type:'project.create',name:`分类容量验证 ${n}`,color:'#7564df',icon:'folder'}),i);
 await page.getByLabel('管理分类 分类容量验证 24',{exact:true}).scrollIntoViewIfNeeded();await checkSidebar();await page.getByLabel('管理分类 分类容量验证 24',{exact:true}).click();
 const menu=page.locator('.project-floating');await menu.waitFor({state:'visible'});const menuBounds=await menu.boundingBox();const height=await page.evaluate(()=>innerHeight);assert(menuBounds.y>=0&&menuBounds.y+menuBounds.height<=height,'scrolled category menu stays inside minimum window');await menu.getByRole('button',{name:'编辑分类',exact:true}).click();await page.getByRole('heading',{name:'编辑分类',exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('.settings-modal').waitFor();await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
 console.log('PASS bundled CJK fonts, light/dark headings, cards, board, editor, settings, quick capture, 920x700 and 900x640 windows; 27-category scrolling, visible footer, category menu and settings at minimum size');
}finally{await app.close();}
