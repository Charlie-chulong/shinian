import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import path from 'node:path';
const platform=process.argv[2]||process.platform;
if(!['win32','linux','darwin'].includes(platform))throw new Error('Supported targets: win32, linux, darwin');
const arch=process.argv[3]||'x64';
if(!['x64','arm64'].includes(arch))throw new Error('Supported architectures: x64, arm64');
const root=process.cwd(), pkg=JSON.parse(await readFile('package.json','utf8'));
const stage=path.join(root,'.package-stage',platform+'-'+arch);
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const name of ['dist','dist-electron'])await cp(name,path.join(stage,name),{recursive:true});
await mkdir(path.join(stage,'assets'),{recursive:true});
for(const name of ['icon.png','icon.ico','icon.icns','icon.svg'])await cp(path.join('assets',name),path.join(stage,'assets',name));
for(const name of ['README.md','THIRD_PARTY_NOTICES.txt']){try{await cp(name,path.join(stage,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
await writeFile(path.join(stage,'package.json'),JSON.stringify({name:'shinian',productName:'拾念',version:pkg.version,description:pkg.description,main:'dist-electron/main.cjs',author:'Shinian',license:'UNLICENSED'},null,2));
// Build in a fresh output directory so an existing release cannot interfere with
// Electron Packager's final directory rename. Replace it only after ZIP succeeds.
const outputRoot=await mkdtemp(path.join(root,'.package-stage','output-'));
const releaseRoot=path.join(root,'release');
await mkdir(releaseRoot,{recursive:true});
const builds=await packager({dir:stage,name:'Shinian',executableName:'Shinian',out:outputRoot,platform,arch,electronVersion:pkg.devDependencies.electron,appVersion:pkg.version,appBundleId:'com.shinian.desktop',appCategoryType:'public.app-category.productivity',asar:true,overwrite:true,prune:false,icon:platform==='win32'?path.join(root,'assets/icon.ico'):platform==='darwin'?path.join(root,'assets/icon.icns'):undefined,win32metadata:{ProductName:'拾念 Shinian',FileDescription:'拾念 · 灵感与待办',CompanyName:'Shinian'},download:{cacheRoot:process.env.ELECTRON_CACHE||path.join(root,'.electron-cache')}});
for(const build of builds){
 await cp('docs/QUICK_START.txt',path.join(build,'使用说明.txt'));
 await cp('THIRD_PARTY_NOTICES.txt',path.join(build,'THIRD_PARTY_NOTICES.txt'));
 const checksums=[];
 const hashFiles=async(dir)=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(dir,entry.name);if(entry.isDirectory())await hashFiles(full);else if(entry.isFile()){const hash=createHash('sha256');for await(const chunk of createReadStream(full))hash.update(chunk);checksums.push(`${hash.digest('hex')}  ${path.relative(build,full).split(path.sep).join('/')}`);}}};
 await hashFiles(build);
 await writeFile(path.join(build,'SHA256SUMS.txt'),checksums.join('\n')+'\n');
 const name=`Shinian-${pkg.version}-${platform==='win32'?'Windows':platform==='darwin'?'macOS':'Linux'}-${arch}`;
 const archive=path.join(releaseRoot,name+'.zip');
 const temporaryArchive=path.join(outputRoot,name+'.zip');
 const zip=new yazl.ZipFile();
 const add=async(dir)=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(dir,entry.name);const relative=`${name}/${path.relative(build,full).split(path.sep).join('/')}`;if(entry.isDirectory())await add(full);else if(entry.isSymbolicLink()){zip.addBuffer(Buffer.from(await readlink(full)),relative,{mode:0o120777});}else{const meta=await stat(full);zip.addFile(full,relative,{mode:meta.mode});}}};
 await add(build);
 const output=createWriteStream(temporaryArchive);
 const complete=new Promise((resolve,reject)=>{output.on('close',resolve);output.on('error',reject);zip.outputStream.on('error',reject);});
 zip.outputStream.pipe(output);zip.end();await complete;
 await rename(temporaryArchive,archive);
 const publishedBuild=path.join(releaseRoot,path.basename(build));
 await rm(publishedBuild,{recursive:true,force:true});
 await rename(build,publishedBuild);
 console.log(`Ready: ${archive}`);
}
await rm(outputRoot,{recursive:true,force:true});
