#!/usr/bin/env python3
"""离线升级执行器。只接受已校验的发布目录和明确安装身份。"""
import argparse
import contextlib
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid

COMMAND_LOG = None

# Only reviewed, backward-readable additions may cross an image boundary.
# Keep this schema on rollback: restoring a database snapshot would lose writes.
ADDITIVE_MIGRATIONS = {
    '054_api_keys_allowed_models.sql': 'eccb672bf1ba395bc8039856f0ee73850c16cb57c53d72b47d516ce25cbe5f56',
}


def sha(file):
    digest=hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()


def safe_relative(name):
    path=PurePosixPath(name)
    return bool(name) and not path.is_absolute() and '..' not in path.parts and '\\' not in name


def atomic_json(file, value):
    atomic_bytes(file,(json.dumps(value,indent=2,ensure_ascii=False)+'\n').encode())


def atomic_bytes(file, data):
    file=Path(file);file.parent.mkdir(parents=True,exist_ok=True)
    fd,temp=tempfile.mkstemp(prefix='.upgrade-',dir=file.parent)
    try:
        with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.chmod(temp,0o600);os.replace(temp,file)
    finally:
        if os.path.exists(temp):os.unlink(temp)


def verify_release(release):
    release=Path(release)
    if release.is_symlink():raise ValueError('发布目录不能是链接')
    manifest=json.loads((release/'release.json').read_text())
    if manifest.get('format')!='vm2api-offline-release-1':raise ValueError('发布格式无效')
    if not re.fullmatch('[0-9a-f]{40}',manifest['source_revision']):raise ValueError('源码提交无效')
    if sha(release/'executor.py')!=manifest['executor_sha256']:raise ValueError('执行器摘要不匹配')
    for digest,size in manifest['objects'].items():
        if not re.fullmatch('[0-9a-f]{64}',digest):raise ValueError('对象名称无效')
        file=release/'objects'/digest
        if file.is_symlink() or not file.is_file() or file.stat().st_size!=size or sha(file)!=digest:raise ValueError('发布对象损坏')
    image=manifest['image'];acceptance=manifest['acceptance']
    if image['architecture']!='amd64' or not all(re.fullmatch('sha256:[0-9a-f]{64}',image[k]) for k in ['id','config_id']):raise ValueError('镜像身份无效')
    if not (acceptance.get('format')=='vm2api-offline-acceptance-1' and acceptance.get('result')=='PASS' and acceptance.get('image_id')==image['id'] and acceptance.get('source_revision')==manifest['source_revision'] and acceptance.get('compatible_from') and acceptance.get('scenarios') and all(x.get('result')=='PASS' for x in acceptance['scenarios'])):raise ValueError('验收身份无效')
    names=set()
    for member in image['members']:
        if not safe_relative(member['name']) or member['name'] in names or manifest['objects'].get(member['sha256'])!=member['size']:raise ValueError('镜像归档索引无效')
        names.add(member['name'])
    hermit=manifest.get('hermit')
    if hermit and (hermit['object']!=hermit['receipt']['archive']['sha256'] or manifest['objects'].get(hermit['object'])!=hermit['receipt']['archive']['bytes'] or acceptance.get('hermit_archive_sha256')!=hermit['object']):raise ValueError('Hermit 验收身份无效')
    return manifest


def command(argv, timeout=180):
    result=subprocess.run(argv,capture_output=True,text=True,timeout=timeout)
    if result.returncode:
        if COMMAND_LOG:
            fd=os.open(COMMAND_LOG,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
            with os.fdopen(fd,'w') as stream:stream.write(json.dumps({'command':argv[:2],'error':result.stderr[-4000:]},ensure_ascii=False)+'\n')
        raise RuntimeError('命令失败：'+argv[0]+' '+argv[1])
    return result.stdout


def inspect(name):
    return json.loads(command(['docker','inspect',name]))[0]


def image_info(name):
    return json.loads(command(['docker','image','inspect',name]))[0]


def loaded_image(manifest):
    image=manifest['image']
    for ref in [image['id'],image['config_id']]:
        try:
            info=image_info(ref)
            if info['RootFS']['Layers']==image['layers'] and info['Config'].get('Labels',{}).get('org.opencontainers.image.revision')==manifest['source_revision']:return info
        except RuntimeError:pass
    return None


def load_image(release,manifest):
    info=loaded_image(manifest)
    if not info:
        fd,temp=tempfile.mkstemp(prefix='image-',suffix='.tar',dir=release)
        os.close(fd)
        try:
            with tarfile.open(temp,'w') as tar:
                for member in manifest['image']['members']:
                    item=tarfile.TarInfo(member['name']);item.size=member['size'];item.mode=member['mode']&0o777
                    with (release/'objects'/member['sha256']).open('rb') as stream:tar.addfile(item,stream)
            command(['docker','load','-i',temp],timeout=900)
        finally:os.unlink(temp)
        info=loaded_image(manifest)
    if not info:raise ValueError('加载后的镜像身份不匹配')
    command(['docker','tag',info['Id'],manifest['image']['ref']])
    return info


def docker_socket():
    host=os.environ.get('DOCKER_HOST','unix:///var/run/docker.sock')
    if not host.startswith('unix://'):raise ValueError('升级执行器只支持本机 Unix Docker socket')
    return host[len('unix://'):]


def start(release,root,project,container,wait=False):
    root=Path(root);state=root/'.upgrades';state.mkdir(mode=0o700,exist_ok=True)
    if state.is_symlink():raise ValueError('升级目录不能是链接')
    state.chmod(0o700)
    manifest=verify_release(release)
    if ':' in str(root) or '\n' in str(root):raise ValueError('安装路径不受支持')
    if root.is_symlink() or not (root/'.env').is_file() or (root/'.env').is_symlink():raise ValueError('安装目录或环境文件无效')
    if (root/'.git').exists():raise ValueError('源码安装应先迁移为镜像安装')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*',project) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',container):raise ValueError('项目或容器名称无效')
    current=inspect(container);labels=current['Config'].get('Labels',{})
    if current['HostConfig']['NetworkMode']!='host' or not current['State']['Running']:raise ValueError('首版只支持正在运行的本机 host 网络部署')
    mounts={m['Destination']:m for m in current['Mounts']}
    for sub in ['data','vms','bin','share','src/config']:
        mount=mounts.get('/opt/vm2api/'+sub,{})
        if mount.get('Type')!='bind' or Path(mount.get('Source','')).resolve()!=(root/sub).resolve():raise ValueError('持久化挂载与安装目录不匹配')
    if labels.get('com.docker.compose.project')!=project or labels.get('com.docker.compose.service')!='vm2api' or Path(labels.get('com.docker.compose.project.working_dir','')).resolve()!=root.resolve():raise ValueError('安装身份不匹配')
    with (state/'launch.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        status=state/'current.json'
        if status.exists():
            previous=json.loads(status.read_text())
            if previous['result']=='RUNNING':
                raise ValueError('存在未结束任务；先查询状态并恢复该任务')
        if current['Image'] in [manifest['image']['id'],manifest['image']['config_id']]:
            command(['docker','exec',container,'node','-e',"fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"])
            Executor.assets(container)
            print(json.dumps({'result':'PASS','phase':'active','unchanged':True}));return
        if current['Image'] not in manifest['acceptance']['compatible_from']:raise ValueError('当前镜像不在已验收兼容范围内')
        info=load_image(release,manifest)
        task=uuid.uuid4().hex
        directory=state/'tasks'/task;directory.mkdir(parents=True,mode=0o700)
        atomic_json(directory/'previous.json',current)
        receipt={'format':'vm2api-upgrade-task-1','task_id':task,'result':'RUNNING','phase':'queued','helper':'vm2api-upgrade-'+task,'release':str(release),'release_sha256':sha(release/'release.json'),'root':str(root),'project':project,'container':container,'image':info['Id'],'previous_image':current['Image'],'source_revision':manifest['source_revision'],'events':[]}
        atomic_json(directory/'status.json',receipt);atomic_json(status,receipt);atomic_json(root/'data/upgrade-status.json',receipt)
        args=['docker','run','-d','--pull=never','--init','--network','host','--name',receipt['helper'],
              '--label','vm2api.upgrade.task='+task,'-v',docker_socket()+':/var/run/docker.sock',
              '-v',str(root)+':'+str(root),'-v',str(release)+':/release:ro','--entrypoint','python3',info['Id'],'/release/executor.py','--root',str(root),'--task',task]
        try:command(args)
        except Exception:
            receipt.update(result='FAIL',phase='launch_failed');atomic_json(directory/'status.json',receipt);atomic_json(status,receipt);atomic_json(root/'data/upgrade-status.json',receipt);raise
    if wait:
        command(['docker','wait',receipt['helper']],timeout=1800)
        final=json.loads((directory/'status.json').read_text());print(json.dumps(final,ensure_ascii=False))
        if final['result']!='PASS':raise SystemExit(1)
    else:print(json.dumps({'result':'STARTED','task_id':task,'status':str(status)},ensure_ascii=False))


def recover(root,wait=False):
    root=Path(root);state=root/'.upgrades'
    with (state/'launch.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        receipt=json.loads((state/'current.json').read_text())
        if receipt['result'] not in ['RUNNING','RECOVERY_REQUIRED']:raise ValueError('当前任务不需要恢复')
        for helper in [receipt['helper'],receipt.get('recovery_helper')]:
            if not helper:continue
            try:
                if inspect(helper)['State']['Running']:raise ValueError('原执行器或恢复执行器仍在运行')
            except RuntimeError:pass
        release=Path(receipt['release']);verify_release(release)
        if sha(release/'release.json')!=receipt['release_sha256']:raise ValueError('原发布工件已变化')
        name='vm2api-recovery-'+uuid.uuid4().hex
        receipt['recovery_helper']=name
        atomic_json(state/'current.json',receipt)
        atomic_json(state/'tasks'/receipt['task_id']/'status.json',receipt)
        command(['docker','run','-d','--pull=never','--init','--network','host','--name',name,
                 '--label','vm2api.upgrade.task='+receipt['task_id'],'-v',docker_socket()+':/var/run/docker.sock',
                 '-v',str(root)+':'+str(root),'-v',str(release)+':/release:ro','--entrypoint','python3',receipt['image'],
                 '/release/executor.py','--root',str(root),'--task',receipt['task_id'],'--recover'])
    if wait:
        command(['docker','wait',name],timeout=1800)
        final=json.loads((state/'current.json').read_text());print(json.dumps(final,ensure_ascii=False))
        if final['result'] not in ['ROLLED_BACK','FAIL']:raise SystemExit(1)
    else:print(json.dumps({'result':'RECOVERING','task_id':receipt['task_id']}))


class Executor:
    def __init__(self,root,task):
        self.root=Path(root);self.state=self.root/'.upgrades';self.directory=self.state/'tasks'/task
        global COMMAND_LOG
        COMMAND_LOG=self.directory/'commands.log'
        self.receipt=json.loads((self.directory/'status.json').read_text())
        self.previous=json.loads((self.directory/'previous.json').read_text())
        self.release=Path('/release');self.manifest=verify_release(self.release)
        if sha(self.release/'release.json')!=self.receipt['release_sha256']:raise ValueError('任务发布身份已改变')
        self.container=self.receipt['container'];self.project=self.receipt['project']
        self.environment=dict(x.split('=',1) for x in self.previous['Config']['Env'] if '=' in x)
        self.base='http://127.0.0.1:'+str(self.environment.get('PORT','8787'))
        self.key=self.environment.get('VM2API_API_KEY') or self.environment.get('KIN_API_KEY')
        if not self.key:raise ValueError('缺少管理 API 密钥')
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        files=self.previous['Config']['Labels'].get('com.docker.compose.project.config_files','').split(',')
        if not files or any(not Path(f).is_file() or not Path(f).resolve().is_relative_to(self.root.resolve()) for f in files):raise ValueError('Compose 文件路径不受支持')
        self.files=files
        self.compose=['docker','compose','--project-directory',str(self.root),'--project-name',self.project,'--env-file',str(self.root/'.env')]
        for file in files:self.compose+=['-f',file]
        self.held=False;self.stopped=False;self.replaced=False;self.resuming=False
        plan=self.directory/'migration-plan.json'
        self.migrations=json.loads(plan.read_text()).get('additions',[]) if plan.exists() else []
        self.reason='upgrade-'+task

    def phase(self,name,**values):
        self.receipt.update(phase=name,**values)
        self.receipt['events'].append({'phase':name,'time':time.time()})
        atomic_json(self.directory/'status.json',self.receipt);atomic_json(self.state/'current.json',self.receipt);atomic_json(self.root/'data/upgrade-status.json',self.receipt)

    def api(self,path,body=None):
        headers={'Authorization':'Bearer '+self.key,'content-type':'application/json'}
        req=urllib.request.Request(self.base+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
        with self.opener.open(req,timeout=135) as response:
            value=json.load(response)
            if value.get('ok') is False:raise RuntimeError('管理接口拒绝请求')
            return value.get('data',value)

    def snapshot(self):
        data=self.api('/api/panel/vms');items=data if isinstance(data,list) else data.get('items',data.get('vms'))
        if not isinstance(items,list):raise ValueError('槽位列表格式无效')
        kernels={}
        for vm in items:
            if vm.get('status')=='running':
                detail=self.api('/api/panel/vms/'+vm['id']);kernel=detail.get('kernel',{})
                h=kernel.get('codex_health') or kernel.get('rust_health') or kernel.get('go_health') or {}
                kernels[vm['id']]=h.get('status')==200 and h.get('healthy') is not False and h.get('process_up') is not False
        records={}
        for item in items:
            file=self.root/'vms'/(item['id']+'.json')
            vm=json.loads(file.read_text())
            if vm.get('id')!=item['id']:raise ValueError('槽位文件与管理接口身份不匹配')
            records[item['id']]={k:vm.get(k) for k in ['dataplane','kernel_package','pending_kernel_package','proxy']}
        return {'slots':{v['id']:{k:v.get(k) for k in ['status','schedule_off','schedulable','schedule_manual']} for v in items},'kernels':kernels,'records':records,
                'credentials':{str(f.relative_to(self.root)):sha(f) for f in (self.root/'vms').rglob('credentials.json') if f.is_file()}}

    def ready(self):
        for _ in range(60):
            try:
                if self.api('/health').get('status')=='ok':return
            except Exception:pass
            time.sleep(.5)
        raise RuntimeError('服务健康检查超时')

    @staticmethod
    def assets(container):
        script=r'''const fs=require('fs'),crypto=require('crypto');(async()=>{const b='http://127.0.0.1:'+(process.env.PORT||8787);const r=await fetch(b+'/cc');if(!r.ok||!r.headers.get('content-type')?.includes('text/html'))throw Error('page');const paths=[...new Set([...((await r.text()).matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g))].map(x=>x[1]))];if(!paths.some(p=>p.endsWith('.js'))||!paths.some(p=>p.endsWith('.css')))throw Error('assets');let out={};for(const p of paths){if(p.includes('..'))throw Error('path');const r=await fetch(b+p);const body=Buffer.from(await r.arrayBuffer());if(!r.ok||!body.equals(fs.readFileSync('/opt/vm2api/web/dist'+p)))throw Error('asset');out[p]=crypto.createHash('sha256').update(body).digest('hex')}console.log(JSON.stringify(out))})().catch(()=>process.exit(1))'''
        return json.loads(command(['docker','exec',container,'node','-e',script],timeout=20))

    def rehearse_migrations(self):
        if not self.migrations:return
        area=self.directory/'migration-rehearsal';area.mkdir(mode=0o700)
        source=sqlite3.connect('file:'+str(self.root/'data/kin.db')+'?mode=ro',uri=True)
        target=sqlite3.connect(area/'kin.db')
        try:source.backup(target)
        finally:target.close();source.close()
        (area/'kin.db').chmod(0o600)
        script="""import {createDatabase} from '/opt/vm2api/src/lib/db/database.mjs';
const db=createDatabase({dbPath:'/upgrade-db/kin.db'});
if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('database integrity');
console.log(JSON.stringify({result:'PASS',versions:db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version)}));db.close();"""
        results=[]
        for image in [self.receipt['image'],self.receipt['previous_image']]:
            value=json.loads(command(['docker','run','--rm','--pull=never','--network','none','--read-only',
                '--mount','type=bind,src='+str(area)+',dst=/upgrade-db','--entrypoint','node',image,'--input-type=module','-e',script]))
            if value.get('result')!='PASS':raise ValueError('数据库迁移或旧版本回读预演失败')
            results.append({'image':image,**value})
        atomic_json(self.directory/'migration-rehearsal.json',{'result':'PASS','checks':results})

    def database_compatibility(self,rollback=False):
        if not self.migrations:return
        for item in self.migrations:
            if ADDITIVE_MIGRATIONS.get(item.get('name'))!=item.get('sha256'):raise ValueError('数据库迁移计划身份无效')
        db=sqlite3.connect('file:'+str(self.root/'data/kin.db')+'?mode=ro',uri=True)
        try:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('数据库一致性检查失败')
            columns={r[1] for r in db.execute('PRAGMA table_info(api_keys)')}
            if 'allowed_models' not in columns:
                if rollback:return
                raise ValueError('054迁移未完成')
            if not rollback:
                row=db.execute("SELECT checksum FROM schema_migrations WHERE version='054'").fetchone()
                if not row or row[0]!=ADDITIVE_MIGRATIONS['054_api_keys_allowed_models.sql']:raise ValueError('054迁移记录不匹配')
            elif db.execute("SELECT COUNT(*) FROM api_keys WHERE allowed_models != '[]'").fetchone()[0]:
                raise ValueError('已使用模型白名单，旧版本不能保持访问限制；保留目标版本并暂停调度')
        finally:db.close()

    def preflight(self):
        command(self.compose+['config','--quiet'])
        name='vm2api-preflight-'+self.receipt['task_id']
        try:
            command(['docker','run','-d','--pull=never','--network','none','--name',name,'--label','vm2api.upgrade.task='+self.receipt['task_id'],
                '-e','VM2API_API_KEY=preflight-synthetic','-e','VM2API_DB_SECRET='+'12'*32,'-e','VM2API_ADMIN_PASSWORD=preflight-synthetic',
                '-e','KIN_AUTO_SYNC_WRAP=0',self.receipt['image']])
            for _ in range(60):
                try:
                    self.preflight_assets=self.assets(name);break
                except Exception:time.sleep(.5)
            else:raise RuntimeError('目标镜像预检失败')
            # Existing migration files and slot payloads must stay byte-identical.
            paths=['src/lib/db/migrations','image-wrap-cli','image-crag']
            for sub in paths:
                old=self.directory/'old'/sub;new=self.directory/'new'/sub
                old.parent.mkdir(parents=True,exist_ok=True);new.parent.mkdir(parents=True,exist_ok=True)
                command(['docker','cp',self.container+':/opt/vm2api/'+sub,str(old)])
                command(['docker','cp',name+':/opt/vm2api/'+sub,str(new)])
                def tree(directory):return {str(p.relative_to(directory)):sha(p) for p in directory.rglob('*') if p.is_file()}
                old_tree=tree(old);new_tree=tree(new)
                if sub!='src/lib/db/migrations':
                    if old_tree!=new_tree:raise ValueError('槽位载荷发生变化，需要协调升级')
                    continue
                if any(new_tree.get(name)!=digest for name,digest in old_tree.items()):raise ValueError('已有数据库迁移被修改或删除')
                additions=[{'name':name,'sha256':digest} for name,digest in sorted(new_tree.items()) if name not in old_tree]
                if any(ADDITIVE_MIGRATIONS.get(item['name'])!=item['sha256'] for item in additions):raise ValueError('新增数据库迁移尚未验收')
                self.migrations=additions
                atomic_json(self.directory/'migration-plan.json',{'additions':additions,'rollback':'retain_backward_compatible_schema'})
            self.rehearse_migrations()
            hermit=self.manifest.get('hermit')
            if hermit:
                cli=hermit['manifest']['cli'];cache=self.root/'share/kernel-packages/cli'/cli['sha256']/'claude'
                if not cache.is_file() or cache.is_symlink() or sha(cache)!=cli['sha256']:
                    if not hermit.get('cli_object'):raise ValueError('官方 CLI 未缓存，应先打包 CLI 依赖')
                    cache.parent.mkdir(parents=True,exist_ok=True);atomic_bytes(cache,(self.release/'objects'/hermit['cli_object']).read_bytes());cache.chmod(0o755)
            if self.environment.get('KIN_KERNEL_TEST_ENDPOINTS')=='1':raise ValueError('生产安装不能启用实验端点')
        finally:
            subprocess.run(['docker','rm','-fv',name],capture_output=True)

    def backup(self):
        backup=self.directory/'backup';backup.mkdir(mode=0o700)
        self.receipt['backup']=str(backup)
        self.original=self.snapshot();atomic_json(self.directory/'original.json',self.original)
        self.others={r['Names']:r['ID'] for r in (json.loads(line) for line in command(['docker','ps','-a','--no-trunc','--format','json']).splitlines()) if r['Names']!=self.container}
        # 默认入口会覆盖这些程序文件；它们在停机前保存。
        for sub in ['bin','share/wrap-cli','share/crag','src/config']:
            source=self.root/sub
            if source.exists():shutil.copytree(source,backup/'static'/sub,symlinks=True)
        for i,file in enumerate(self.files):shutil.copy2(file,backup/('compose-'+str(i)))
        shutil.copy2(self.root/'.env',backup/'.env')
        self.phase('drain')
        self.held=True
        held=self.api('/api/panel/vms/schedule/hold',{'reason':self.reason})
        if held.get('drained') is not True or held.get('inflight')!=0:raise ValueError('请求没有排空')
        pool=self.api('/admin/routing').get('pool',{})
        if any(int(v or 0)>0 for v in pool.get('inflight',{}).values()):raise ValueError('仍有在途请求')
        if pool.get('pool_queue',{}).get('global_queue_depth',0):raise ValueError('仍有排队请求')
        self.baseline=self.snapshot();atomic_json(self.directory/'baseline.json',self.baseline)
        self.phase('backup')
        self.stopped=True
        command(self.compose+['stop','-t','60','vm2api'])
        if inspect(self.container)['State']['Running']:raise ValueError('控制平面仍在运行')
        with tarfile.open(backup/'state.tar','w') as tar:
            def include(item):
                parts=PurePosixPath(item.name).parts
                if any(p in ['run','tmp'] for p in parts):return None
                if not (item.isdir() or item.isfile() or item.issym()):return None
                return item
            for sub in ['data','vms','src/config']:
                if (self.root/sub).exists():tar.add(self.root/sub,arcname=sub,filter=include)
        os.chmod(backup/'state.tar',0o600)
        db=sqlite3.connect('file:'+str(self.root/'data/kin.db')+'?mode=ro',uri=True)
        try:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('数据库一致性检查失败')
            target=sqlite3.connect(backup/'kin.db')
            try:db.backup(target)
            finally:target.close()
        finally:db.close()
        os.chmod(backup/'kin.db',0o600)
        atomic_json(backup/'checksums.json',{n:sha(backup/n) for n in ['.env','state.tar','kin.db']})

    def prepare_target(self):
        ref=self.manifest['image']['ref'];repository,tag=ref.rsplit(':',1)
        source=(self.root/'.env').read_text();values={'VM2API_IMAGE':repository,'VM2API_IMAGE_TAG':tag};seen=set();lines=[]
        for line in source.splitlines():
            key=line.split('=',1)[0]
            if key in values:
                if key in seen:raise ValueError('环境文件包含重复镜像配置')
                seen.add(key);lines.append(key+'='+values[key])
            else:lines.append(line)
        lines += [k+'='+v for k,v in values.items() if k not in seen]
        staged=self.directory/'target.env';atomic_bytes(staged,('\n'.join(lines)+'\n').encode())
        config=self.compose.copy();config[config.index('--env-file')+1]=str(staged)
        view=json.loads(command(config+['config','--format','json']))['services']['vm2api']
        if view['image']!=ref or view['container_name']!=self.container:raise ValueError('目标 Compose 身份不匹配')
        self.staged=staged

    def replace(self):
        self.phase('replace');self.replaced=True
        atomic_bytes(self.root/'.env',self.staged.read_bytes())
        command(self.compose+['up','-d','--no-deps','--pull','never','--force-recreate','vm2api'])
        self.ready()
        if inspect(self.container)['Image']!=self.receipt['image']:raise ValueError('活动镜像不匹配')

    def verify(self):
        self.database_compatibility()
        current=self.snapshot()
        if current['records']!=self.baseline['records'] or set(current['slots'])!=set(self.baseline['slots']):raise ValueError('槽位配置发生变化')
        if any(ok and not current['kernels'].get(id) for id,ok in self.baseline['kernels'].items()):raise ValueError('原健康内核不可用')
        if current['credentials']!=self.baseline['credentials']:raise ValueError('凭据发生变化，需要核对刷新记录')
        assets=self.assets(self.container)
        if assets!=self.preflight_assets:raise ValueError('线上资源与预检镜像不一致')
        atomic_json(self.directory/'verification.json',{'result':'PASS','assets':assets,'kernel_health':current['kernels'],'credentials_unchanged':True})

    def install_hermit(self):
        hermit=self.manifest.get('hermit')
        if not hermit:return
        # 安装器复用内容寻址 CLI 缓存；缺少依赖时在切换前拒绝。
        receipt=hermit['receipt'];raw=(self.release/'objects'/hermit['object']).read_bytes()
        req=urllib.request.Request(self.base+'/api/panel/kernel-packages',data=raw,headers={'Authorization':'Bearer '+self.key,'content-type':'application/gzip','X-Kernel-Sha256':hermit['object'],'X-Kernel-Bytes':str(len(raw)),'X-Kernel-Manifest-Sha256':receipt['manifest_sha256']})
        with self.opener.open(req,timeout=120) as response:
            value=json.load(response)
            if not value.get('ok') or value.get('data',{}).get('activated') is not False:raise ValueError('Hermit 安装状态无效')
        self.receipt['hermit_installed']=True

    def rollback(self):
        if self.resuming:
            held=self.api('/api/panel/vms/schedule/hold',{'reason':self.reason})
            if held.get('drained') is not True or held.get('inflight')!=0:raise ValueError('恢复调度后无法再次排空，不能自动回滚')
            self.held=True
        self.phase('rollback')
        if self.stopped:
            if not (self.directory/'migration-plan.json').is_file():raise ValueError('迁移计划缺失，不能自动回滚')
            self.database_compatibility(rollback=True)
            command(self.compose+['stop','-t','30','vm2api'])
            if inspect(self.container)['State']['Running']:raise ValueError('目标控制平面停止尚未确认')
            self.database_compatibility(rollback=True)
            backup=self.directory/'backup'
            if (backup/'.env').exists():atomic_bytes(self.root/'.env',(backup/'.env').read_bytes())
            for sub in ['bin','share/wrap-cli','share/crag','src/config']:
                source=backup/'static'/sub
                if source.exists():
                    target=self.root/sub
                    if target.exists():shutil.rmtree(target)
                    shutil.copytree(source,target,symlinks=True)
            command(['docker','tag',self.receipt['previous_image'],self.previous['Config']['Image']])
            command(self.compose+['up','-d','--no-deps','--pull','never','--force-recreate','vm2api'])
            self.ready()
            if inspect(self.container)['Image']!=self.receipt['previous_image']:raise ValueError('回滚镜像不匹配')
            current=self.snapshot()
            if any(ok and not current['kernels'].get(id) for id,ok in self.baseline['kernels'].items()):raise ValueError('回滚内核检查失败')
            self.assets(self.container)
        if self.held:self.api('/api/panel/vms/schedule/resume',{'reason':self.reason});self.held=False
        self.phase('rolled_back' if self.stopped else 'failed',result='ROLLED_BACK' if self.stopped else 'FAIL')

    def execute(self,recovery=False):
        with (self.state/'execute.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                if recovery:
                    phases={v['phase'] for v in self.receipt['events']}
                    self.held='drain' in phases
                    self.stopped='backup' in phases
                    self.resuming='resume' in phases
                    baseline=self.directory/'baseline.json'
                    self.baseline=json.loads(baseline.read_text()) if baseline.exists() else {'kernels':{}}
                    self.rollback();return 0
                self.phase('preflight');self.preflight();self.prepare_target()
                self.backup();self.replace();self.phase('verify');self.verify()
                self.install_hermit()
                others={r['Names']:r['ID'] for r in (json.loads(line) for line in command(['docker','ps','-a','--no-trunc','--format','json']).splitlines())}
                if any(others.get(k)!=v for k,v in self.others.items()):raise ValueError('其他容器身份发生变化')
                self.resuming=True;self.phase('resume');self.api('/api/panel/vms/schedule/resume',{'reason':self.reason})
                after=self.snapshot()
                if after['slots']!=self.original['slots']:raise ValueError('调度状态没有恢复')
                self.held=False
                self.phase('active',result='PASS',scheduling_restored=True)
            except Exception as error:
                # 公开收据不保留外部响应或命令输出，避免反射凭据。
                self.receipt['failure_phase']=self.receipt['phase'];self.receipt['error']=type(error).__name__+': '+str(error)
                try:self.rollback()
                except Exception as failure:self.phase('recovery_required',result='RECOVERY_REQUIRED',recovery_error=type(failure).__name__)
                return 1
        return 0


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);parser.add_argument('--task',required=True);parser.add_argument('--recover',action='store_true')
    args=parser.parse_args()
    try:return Executor(args.root,args.task).execute(args.recover)
    except Exception:
        directory=args.root/'.upgrades/tasks'/args.task
        if (directory/'status.json').exists():
            receipt=json.loads((directory/'status.json').read_text());receipt.update(result='RECOVERY_REQUIRED',phase='executor_failed')
            atomic_json(directory/'status.json',receipt);atomic_json(args.root/'.upgrades/current.json',receipt)
        return 1

if __name__=='__main__':raise SystemExit(main())
