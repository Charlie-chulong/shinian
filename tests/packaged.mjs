/** Runs the exact Windows app.asar inside a separately packaged Linux Electron runtime.
 * This verifies production ASAR paths/bridges and shared app code, not native Windows integration.
 */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { cp, rename, rm, mkdir, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {listPackage,extractFile} from '@electron/asar';
const root=process.cwd();const temp=await mkdtemp(path.join(os.tmpdir(),'shinian-packaged-'));
const runtime=path.join(temp,'runtime');const profile=path.join(temp,'profile');
const winDir=path.join(root,'release','Shinian-win32-x64');const asar=path.join(winDir,'resources','app.asar');
const bytes=await readFile(asar);const hash=createHash('sha256').update(bytes).digest('hex');const entries=listPackage(asar);
for(const suffix of ['/package.json','/dist/index.html','/dist-electron/main.cjs','/dist-electron/preload.cjs','/assets/icon.ico','/assets/icon.png'])assert(entries.some(p=>p.replaceAll('\\','/')===suffix),suffix);
const html=extractFile(asar,'dist/index.html').toString();for(const ref of [...html.matchAll(/(?:src|href)="\.\/([^" ]+)"/g)].map(m=>m[1]))assert(entries.includes('/dist/'+ref),ref);
assert(entries.some(p=>p.endsWith('.woff2')),'bundled CJK font');
const exe=await readFile(path.join(winDir,'Shinian.exe'));assert.equal(exe.subarray(0,2).toString(),'MZ');const pe=exe.readUInt32LE(0x3c);assert.equal(exe.readUInt32LE(pe),0x4550);assert.equal(exe.readUInt16LE(pe+4),0x8664);
console.log('PASS Windows x64 PE header and complete ASAR asset references');
await cp(path.join(root,'node_modules/electron/dist'),runtime,{recursive:true});await rename(path.join(runtime,'electron'),path.join(runtime,'Shinian'));await rm(path.join(runtime,'resources/default_app.asar'),{force:true});await cp(asar,path.join(runtime,'resources/app.asar'));
const app=await electron.launch({executablePath:path.join(runtime,'Shinian'),args:['--no-sandbox','--disable-gpu',`--user-data-dir=${profile}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':91'}});
const checks=[];try{
 const production=await app.evaluate(({app})=>({packaged:app.isPackaged,path:app.getAppPath(),version:app.getVersion()}));assert.equal(production.packaged,true);assert(production.path.endsWith('app.asar'));assert.equal(production.version,'1.0.0');checks.push('production ASAR startup');
 const page=await app.firstWindow();await page.waitForSelector('.app-shell');await page.evaluate(()=>document.fonts.ready);assert(await page.evaluate(()=>document.fonts.check('16px "Shinian Sans"','拾念灵感')));checks.push('packaged CJK rendering');
 const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert(prefs.sandbox&&prefs.contextIsolation&&!prefs.nodeIntegration&&!prefs.devTools);assert.equal(await page.evaluate(()=>typeof window.require),'undefined');checks.push('production renderer isolation and limited bridge');
 await page.getByLabel('记录标题',{exact:true}).fill('从真正打包的程序中记录');await page.getByLabel('保存记录',{exact:true}).click();await page.getByRole('article',{name:'从真正打包的程序中记录',exact:true}).waitFor();
 const q=app.waitForEvent('window');await page.evaluate(()=>window.shinian.openQuickCapture());const quick=await q;await quick.waitForSelector('.quick-app');await quick.getByLabel('标题',{exact:true}).fill('打包版快捷记录');await quick.getByRole('button',{name:'收下灵感',exact:true}).click();
 await page.getByRole('article',{name:'打包版快捷记录',exact:true}).waitFor();await quick.waitForTimeout(550);const hidden=await app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('quick=1')).isVisible());assert(hidden,'quick capture auto-hides after save despite non-storage platform notice');checks.push('real packaged main and quick capture persist and synchronize');
 const info=await page.evaluate(()=>window.shinian.getInfo());assert.equal(info.storageWarning,undefined);assert.equal(typeof info.systemNotice,'string');checks.push('platform notices do not masquerade as storage failures');
 await app.close();const saved=JSON.parse(await readFile(path.join(profile,'shinian.json'),'utf8'));assert.equal(saved.items.length,2);checks.push('clean production shutdown and committed files');
 console.log('PASS',checks.join('; '));
 await writeFile(path.join(root,'test-results/packaged-results.json'),JSON.stringify({passed:true,platform:'Linux runtime with exact Windows app.asar',windowsNativeExecution:false,asarSha256:hash,checks,windowsPeMachine:'0x8664',asarEntries:entries.length},null,2));
}catch(error){console.error(error);await app.evaluate(({app})=>app.exit(1)).catch(()=>{});throw error;}
