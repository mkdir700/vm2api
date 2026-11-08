#!/usr/bin/env python3
"""在独立 Docker daemon 中验证离线发布、升级和回滚。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import traceback


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-image', required=True)
    parser.add_argument('--dind-image', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--hermit-package', type=Path)
    parser.add_argument('--cli', type=Path)
    parser.add_argument('--compose-binary', type=Path, required=True)
    parser.add_argument('--web-dist', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=False)
    fixture = Path(tempfile.mkdtemp(prefix='vm2api-upgrade-')); fixture.chmod(0o755)
    owner = fixture.name
    sock = fixture/'docker.sock'
    env = {**os.environ, 'DOCKER_HOST': 'unix://'+str(sock)}
    checks = []
    namespace=None
    result = {'result': 'FAIL'}
    sources = [repo/'deploy/upgrade.py', repo/'deploy/upgrade_executor.py', repo/'scripts/docker-entrypoint.sh', repo/'Dockerfile', repo/'deploy/install.sh', repo/'src/lib/admin/panel-routes.mjs', Path(__file__)]
    pins = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources if p.exists()}
    def run(cmd, expected=0, **kwargs):
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, **kwargs)
        if proc.returncode != expected:
            (out/'command-error.json').write_text(json.dumps({'cmd':cmd,'code':proc.returncode,'stdout':proc.stdout,'stderr':proc.stderr},indent=2))
            raise RuntimeError('命令结果不符合预期，参见 command-error.json')
        return proc.stdout
    def dock(cmd, **kwargs): return run(['docker', *cmd], env=env, **kwargs)
    def check(name, value):
        checks.append({'name': name, 'result': 'PASS' if value else 'FAIL'})
        if not value: raise RuntimeError(name)
    def api(path, body=None):
        script = "const r=await fetch('http://127.0.0.1:8787'+process.argv[1],{method:process.argv[2],headers:{authorization:'Bearer synthetic-upgrade-key','content-type':'application/json'},body:process.argv[3]||undefined});console.log(JSON.stringify({status:r.status,body:await r.json()}))"
        return json.loads(dock(['exec', 'control', 'node', '--input-type=module', '-e', script, path, 'POST' if body is not None else 'GET', json.dumps(body) if body is not None else '']))
    def execute(bundle, expected=0):
        return json.loads(run(['python3', str(repo/'deploy/upgrade.py'), 'apply', '--release', str(bundle), '--root', str(root), '--project', 'fixture', '--container', 'control', '--wait'], expected=expected, env=env))
    try:
        run(['docker', 'run', '-d', '--name', owner, '--pull=never', '--network', 'none', '--privileged', '--cgroupns', 'private', '--tmpfs', '/tmp:rw,mode=1777',
             '--mount', f'type=bind,src={fixture},dst={fixture}', '--entrypoint', '/usr/local/bin/dockerd-entrypoint.sh', args.dind_image,
             'dockerd', '--host', 'unix://'+str(sock), '--data-root', str(fixture/'daemon-data'), '--exec-root', str(fixture/'daemon-exec'), '--pidfile', str(fixture/'daemon.pid')])
        parent=json.loads(run(['docker','inspect',owner]))[0]
        namespace=os.readlink('/proc/'+str(parent['State']['Pid'])+'/ns/net')
        for _ in range(150):
            info=subprocess.run(['docker','info'],env=env,capture_output=True,text=True)
            if info.returncode == 0: break
            time.sleep(.2)
        else:
            (out/'info-error.txt').write_text(info.stdout+info.stderr)
            raise RuntimeError('隔离 daemon 未就绪')
        saved = fixture/'base.tar'
        run(['docker','save','-o',str(saved),args.base_image])
        with tarfile.open(saved) as tar:
            manifest = json.load(tar.extractfile('manifest.json'))
            cfg = tar.extractfile(manifest[0]['Config']).read()
        dock(['load','-i',str(saved)])
        imported = args.base_image
        if subprocess.run(['docker','image','inspect',imported],env=env,capture_output=True).returncode:
            imported='sha256:'+hashlib.sha256(cfg).hexdigest()
        original=json.loads(run(['docker','image','inspect',args.base_image]))[0]
        assert json.loads(dock(['image','inspect',imported]))[0]['RootFS']==original['RootFS']
        dock(['tag',imported,'offline-fixture:base'])
        imported='offline-fixture:base'
        root = fixture/'installation'; root.mkdir()
        context = fixture/'context'; context.mkdir()
        shutil.copytree(args.web_dist,context/'web-dist')
        shutil.copy2(args.compose_binary,context/'docker-compose')
        shutil.copy2(repo/'scripts/docker-entrypoint.sh', context/'entrypoint.sh')
        shutil.copy2(repo/'src/lib/admin/panel-routes.mjs', context/'panel-routes.mjs')
        for name, rev, broken in [('old','1'*40,False),('new','2'*40,False),('bad','3'*40,True)]:
            (context/'Dockerfile').write_text(f'FROM {imported}\nLABEL org.opencontainers.image.revision="{rev}"\nCOPY web-dist /opt/vm2api/web/dist\nCOPY docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose\nCOPY entrypoint.sh /usr/local/bin/vm2api-entrypoint\nCOPY panel-routes.mjs /opt/vm2api/src/lib/admin/panel-routes.mjs\nRUN chmod 755 /usr/local/bin/vm2api-entrypoint\n'+('COPY broken.sh /broken.sh\nENTRYPOINT ["/bin/sh", "/broken.sh"]\n' if broken else ''))
            (context/'broken.sh').write_text('if [ "${SYNTHETIC_DEPLOY_FAIL:-}" = 1 ]; then rm -f /opt/vm2api/web/dist/assets/*.js; fi\nexec /usr/local/bin/vm2api-entrypoint\n')
            dock(['build','--network','none','-t','offline-fixture:'+name,str(context)])
        for name in ['data','vms','src/config','bin','share']: (root/name).mkdir(parents=True,exist_ok=True)
        (root/'.env').write_text('VM2API_IMAGE=offline-fixture\nVM2API_IMAGE_TAG=old\nVM2API_CONTAINER_NAME=control\nVM2API_API_KEY=synthetic-upgrade-key\nVM2API_ADMIN_PASSWORD=synthetic-password\nVM2API_DB_SECRET='+'12'*32+'\nKIN_AUTO_SYNC_WRAP=0\nSYNTHETIC_DEPLOY_FAIL=1\n')
        (root/'.env').chmod(0o600)
        credential=root/'vms/paused/cli-home/credentials.json';credential.parent.mkdir(parents=True,exist_ok=True)
        credential.write_text(json.dumps({'type':'apikey','anthropicApiKey':{'apiKey':'sk-ant-api03-offline-upgrade-synthetic'}}));credential.chmod(0o600)
        credential_digest=hashlib.sha256(credential.read_bytes()).hexdigest()
        for id, off in [('paused',True),('ready',False)]:
            (root/'vms'/f'{id}.json').write_text(json.dumps({'id':id,'name':id,'status':'stopped','schedulable':not off,'schedule_off':off,'schedule_manual':off,'proxy':None,'claude':{},'kernel':'ubuntu-24.04'}))
        (root/'docker-compose.yml').write_text(f'services:\n  vm2api:\n    image: ${{VM2API_IMAGE}}:${{VM2API_IMAGE_TAG}}\n    container_name: control\n    network_mode: host\n    init: true\n    env_file: [.env]\n    environment:\n      KIN_PROJECT_ROOT: /opt/vm2api\n    volumes:\n      - {sock}:/var/run/docker.sock\n'+''.join(f'      - {root}/{name}:/opt/vm2api/{name}\n' for name in ['data','vms','src/config','bin','share']))
        dock(['compose','--project-directory',str(root),'-p','fixture','up','-d','--pull','never'])
        for _ in range(80):
            try:
                if api('/health')['status']==200:break
            except Exception:pass
            time.sleep(.25)
        else:raise RuntimeError('原控制平面未就绪')
        (out/'baseline.json').write_text(json.dumps(api('/api/panel/vms'),indent=2))
        credential_digest=hashlib.sha256(credential.read_bytes()).hexdigest()
        sentinel=dock(['run','-d','--network','none','--name','unrelated-sentinel','--entrypoint','sleep',imported,'infinity']).strip()
        before = json.loads(dock(['inspect','control']))[0]
        # 先对尚未实现的命令运行，保存红灯，再实现生产代码。
        bundles = {}
        for name, rev in [('new','2'*40),('bad','3'*40)]:
            image = json.loads(dock(['image','inspect','offline-fixture:'+name]))[0]
            acceptance = fixture/(name+'-acceptance.json')
            accepted={'format':'vm2api-offline-acceptance-1','result':'PASS','image_id':image['Id'],'source_revision':rev,'compatible_from':[before['Image'],json.loads(dock(['image','inspect','offline-fixture:new']))[0]['Id']],'scenarios':[{'name':'synthetic-release-fixture','result':'PASS'}]}
            if args.hermit_package:accepted['hermit_archive_sha256']=json.loads((args.hermit_package/'release.json').read_text())['archive']['sha256']
            if name=='bad':
                accepted={'result':'PASS','native':{'result':'PASS'},'control_image':image['Id'],'source_unchanged':True,'namespace_gone':True,'daemon_removed':True,'fixture_removed':True,'unexpected_processes':{},'binaries':{'archive':accepted.get('hermit_archive_sha256')}}
            acceptance.write_text(json.dumps(accepted))
            bundle = fixture/('release-'+name)
            run(['python3',str(repo/'deploy/upgrade.py'),'pack','--image','offline-fixture:'+name,'--acceptance',str(acceptance),'--output',str(bundle),*(['--compatible-from',before['Image'],'--compatible-from',json.loads(dock(['image','inspect','offline-fixture:new']))[0]['Id']] if name=='bad' else []),*(['--hermit-package',str(args.hermit_package),'--cli',str(args.cli)] if args.hermit_package else [])],env=env)
            bundles[name]=bundle
        for bundle in bundles.values():
            exported=json.loads((bundle/'release.json').read_text())
            dock(['image','rm','--force',exported['image']['id']])
        check('目标镜像已移除以验证真实离线导入',subprocess.run(['docker','image','inspect',json.loads((bundles['new']/'release.json').read_text())['image']['id']],env=env,capture_output=True).returncode!=0)
        manifest = json.loads((bundles['new']/'release.json').read_text())
        first = next(iter(manifest['objects']))
        data = bundles['new']/'objects'/first
        original = data.read_bytes(); data.write_bytes(b'corrupt')
        execute(bundles['new'],expected=1)
        check('坏工件在停止原服务前被拒绝',json.loads(dock(['inspect','control']))[0]['Id']==before['Id'])
        data.write_bytes(original)
        active = execute(bundles['new'])
        check('完整离线升级成功',active['result']=='PASS' and active['phase']=='active')
        shown=api('/api/panel/upgrade-task')
        check('面板API读取同一持久化任务',shown['status']==200 and shown['body']['data']['task']['task_id']==active['task_id'])
        check('离线安装拒绝旧的Release升级入口',api('/api/panel/update',{'confirm':True})['status']==409)
        run(['bash',str(repo/'deploy/install.sh'),'upgrade','--dir',str(root)],expected=1,env=env)
        check('旧命令行入口不会覆盖离线安装',json.loads(dock(['inspect','control']))[0]['Image']==manifest['image']['id'])
        if args.hermit_package:
            check('Hermit安装后未激活',active.get('hermit_installed') is True and api('/api/panel/kernel-packages')['body']['data']['items'])
        check('镜像与发布清单一致',json.loads(dock(['inspect','control']))[0]['Image']==manifest['image']['id'])
        paused = api('/api/panel/vms/paused')['body']['data']
        check('原人工暂停保持',paused['vm']['schedule_off'] if 'vm' in paused else paused.get('schedule_off') or paused.get('schedulable') is False)
        repeated=execute(bundles['new'])
        check('相同目标重复执行不重建',repeated['result']=='PASS' and repeated.get('unchanged') is True)
        started=json.loads(run(['python3',str(repo/'deploy/upgrade.py'),'apply','--release',str(bundles['bad']),'--root',str(root),'--project','fixture','--container','control'],env=env))
        check('升级任务独立提交',started['result']=='STARTED')
        current=json.loads((root/'.upgrades/current.json').read_text())
        dock(['kill',current['helper']])
        run(['python3',str(repo/'deploy/upgrade.py'),'apply','--release',str(bundles['bad']),'--root',str(root),'--project','fixture','--container','control'],expected=1,env=env)
        check('未结束任务阻止重复升级',json.loads((root/'.upgrades/current.json').read_text())['task_id']==current['task_id'])
        recovered=json.loads(run(['python3',str(repo/'deploy/upgrade.py'),'recover','--root',str(root),'--wait'],env=env))
        check('执行器中断后可恢复',recovered['result'] in ['FAIL','ROLLED_BACK'] and json.loads(dock(['inspect','control']))[0]['Image']==manifest['image']['id'])
        failed=execute(bundles['bad'],expected=1)
        check('切换后页面故障触发回滚',failed['result']=='ROLLED_BACK')
        check('回滚恢复原镜像',json.loads(dock(['inspect','control']))[0]['Image']==manifest['image']['id'])
        check('可读健康检查恢复',api('/health')['status']==200)
        backup=Path(active['backup']);digests=json.loads((backup/'checksums.json').read_text())
        check('停机备份摘要可验证',all(hashlib.sha256((backup/n).read_bytes()).hexdigest()==h for n,h in digests.items()))
        db=sqlite3.connect('file:'+str(backup/'kin.db')+'?mode=ro',uri=True)
        try:check('备份数据库一致性通过',db.execute('pragma quick_check').fetchone()[0]=='ok')
        finally:db.close()
        check('非空凭据在升级和回滚后保持',hashlib.sha256(credential.read_bytes()).hexdigest()==credential_digest)
        check('其他容器身份保持',json.loads(dock(['inspect','unrelated-sentinel']))[0]['Id']==sentinel)
        (out/'backup-verification.json').write_text(json.dumps({'checksums':digests,'database':'ok','credentials_unchanged':True,'other_container_unchanged':True},indent=2))
        result['result']='PASS'
    except Exception:
        (out/'error.txt').write_text(traceback.format_exc())
    finally:
        if args.compose_binary.exists():result['compose_sha256']=hashlib.sha256(args.compose_binary.read_bytes()).hexdigest()
        result['web_dist_sha256']={str(p.relative_to(args.web_dist)):hashlib.sha256(p.read_bytes()).hexdigest() for p in args.web_dist.rglob('*') if p.is_file()}
        subprocess.run(['docker','logs','control'],env=env,stdout=(out/'control.log').open('w'),stderr=subprocess.STDOUT)
        if (fixture/'installation/.upgrades').exists():
            for file in (fixture/'installation/.upgrades').rglob('status.json'):
                target=out/'tasks'/file.parent.name/'status.json';target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
        subprocess.run(['docker','logs',owner],stdout=(out/'daemon.log').open('w'),stderr=subprocess.STDOUT)
        subprocess.run(['docker','rm','-fv',owner],capture_output=True)
        # daemon 的独立网络命名空间销毁后，不保留可运行工件，只保留收据和源码。
        result.update(checks=checks,daemon_removed=subprocess.run(['docker','inspect',owner],capture_output=True).returncode!=0,
                      source_unchanged=all((repo/n).exists() and hashlib.sha256((repo/n).read_bytes()).hexdigest()==h for n,h in pins.items()))
        for n in pins:
            target=out/'sources'/n;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(repo/n,target)
        remaining=[]
        if namespace:
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit():continue
                try:
                    if os.readlink(proc/'ns/net')==namespace:remaining.append(int(proc.name))
                except OSError:pass
        result['namespace_gone']=not remaining;result['unexpected_processes']=remaining
        if remaining:result['result']='FAIL'
        shutil.rmtree(fixture,ignore_errors=True)
        result['fixture_removed']=not fixture.exists()
        (out/'receipt.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
    return 0 if result['result']=='PASS' else 1

if __name__=='__main__':raise SystemExit(main())
