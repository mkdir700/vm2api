#!/usr/bin/env python3
"""在独立 Docker daemon 中验收标准 Hermit 槽位创建和透明出口。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import tarfile
import time
import traceback


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--oauth', action='store_true', help='验证 OAuth helper 与刷新后消息续接')
    parser.add_argument('--slot-api-key', action='store_true', help='验证槽位独立 API Key')
    for name in ('out', 'node', 'archive', 'receipt', 'cli-source', 'api-kernel', 'egress', 'sing-box', 'computer'):
        parser.add_argument('--'+name, required=True, type=Path)
    parser.add_argument('--image', required=True)
    parser.add_argument('--dind-image', required=True)
    parser.add_argument('--control-image', help='真实控制平面镜像完整 ID；要求受管场景')
    parser.add_argument('--managed-image', help='受管 sing-box 镜像完整 ID；启用 Hysteria 2 场景')
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[2]
    sources = sorted({*repo.glob('src/**/*.mjs'), *repo.glob('scripts/*.py'), *repo.glob('test/e2e/hermit-*'), *repo.glob('test/fixtures/hermit-*'), repo/'docker/kin-os/ubuntu-24.04/Dockerfile',repo/'deploy/payload.json',repo/'docker-compose.yml',repo/'deploy/init-managed-egress.sh'})
    computer_pin = next(item for item in json.load(open(repo/'deploy/payload.json'))['files'] if item['path']=='bin/kin-computer')
    assert sha(args.computer) == computer_pin['sha256'] and args.computer.stat().st_size == computer_pin['size']
    pins = {str(p.relative_to(repo)): sha(p) for p in sources if p.is_file()}
    fixture = Path(tempfile.mkdtemp(prefix='hmf-', dir='/tmp')); fixture.chmod(0o755)
    name = 'hermit-factory-'+fixture.name
    sock = fixture/'docker.sock'
    inner_env = {**os.environ, 'DOCKER_HOST': 'unix://'+str(sock)}
    namespace = None
    baseline = set()
    result = {'result': 'FAIL'}
    def docker(argv, **kwargs):
        value = subprocess.run(['docker', *argv], capture_output=True, text=True, **kwargs)
        if value.returncode:
            (out/'docker-error.json').write_text(json.dumps({'args':argv,'stdout':value.stdout,'stderr':value.stderr},indent=2)+'\n')
            raise RuntimeError('Docker 操作失败，参见 docker-error.json')
        return value
    def processes():
        items = {}
        for p in Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            try:
                if namespace and os.readlink(p/'ns/net') == namespace:
                    items[int(p.name)] = (p/'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            except OSError: pass
        return items
    try:
        for image in [args.image, args.dind_image]:
            assert image.startswith('sha256:') and len(image) == 71
            assert json.loads(docker(['image','inspect',image]).stdout)[0]['Id'] == image
        docker(['run','-d','--pull=never','--name',name,'--label','hermit.e2e='+fixture.name,
            '--network','none','--privileged','--cgroupns','private','--tmpfs','/tmp:rw,mode=1777','--mount','type=bind,src='+str(fixture)+',dst='+str(fixture),
            '--entrypoint','/usr/local/bin/dockerd-entrypoint.sh',args.dind_image,'dockerd','--host','unix://'+str(sock),
            '--data-root',str(fixture/'daemon-data'),'--exec-root',str(fixture/'daemon-exec'),
            '--pidfile',str(fixture/'daemon.pid'),*([] if args.managed_image else ['--storage-driver','vfs'])])
        info = json.loads(docker(['inspect',name]).stdout)[0]
        pid = info['State']['Pid']; namespace = os.readlink('/proc/'+str(pid)+'/ns/net')
        assert namespace != os.readlink('/proc/1/ns/net') and info['HostConfig']['NetworkMode'] == 'none'
        (out/'daemon.json').write_text(json.dumps({k:info[k] for k in ['Id','Image','Mounts','State','HostConfig']},indent=2)+'\n')
        deadline = time.monotonic()+30
        while time.monotonic()<deadline:
            if subprocess.run(['docker','info'],env=inner_env,capture_output=True).returncode == 0: break
            time.sleep(.2)
        else: raise RuntimeError('隔离 daemon 未就绪')
        baseline = set(processes())
        archive = fixture/'image.tar'
        subprocess.run(['docker','save','-o',str(archive),args.image],check=True)
        loaded = docker(['load','-i',str(archive)],env=inner_env)
        (out/'image-load.txt').write_text(loaded.stdout+loaded.stderr)
        original = json.loads(docker(['image','inspect',args.image]).stdout)[0]
        with tarfile.open(archive) as saved:
            manifest = json.load(saved.extractfile('manifest.json'))
            configs = [saved.extractfile(entry['Config']).read() for entry in manifest]
        indexed = subprocess.run(['docker','image','inspect',args.image],env=inner_env,capture_output=True,text=True)
        imported_images = json.loads(indexed.stdout) if indexed.returncode == 0 else [json.loads(docker(['image','inspect','sha256:'+hashlib.sha256(config).hexdigest()],env=inner_env).stdout)[0] for config in configs]
        (out/'image-export.json').write_text(json.dumps({'manifest':manifest,'original':original,'imported_images':imported_images,'configs':[json.loads(body) for body in configs]},indent=2)+'\n')
        matches = []
        for config in configs:
            doc = json.loads(config)
            if doc.get('rootfs',{}).get('diff_ids') != original['RootFS']['Layers']: continue
            if not all(doc.get('config',{}).get(k) == v for k,v in original['Config'].items()): continue
            digest = 'sha256:'+hashlib.sha256(config).hexdigest()
            matches.extend(image for image in imported_images if image['Id'] in (digest, original['Id']) and image['RootFS'] == original['RootFS'])
        assert len(matches) == 1, '导出镜像没有唯一的原配置和根文件系统匹配'
        imported = matches[0]
        assert all(imported[field] == original[field] for field in ['RootFS','Architecture','Os'])
        (out/'image-identity.json').write_text(json.dumps({'original_id':original['Id'],'imported_id':imported['Id'],'rootfs':imported['RootFS'],'config_digest_verified':True},indent=2)+'\n')
        docker(['tag',imported['Id'],'127.0.0.1:1/hermit-fixture/kin-os-ubuntu:24.04'],env=inner_env)
        if args.managed_image:
            reference = 'ghcr.io/sagernet/sing-box:v1.12.0@sha256:3c1ee82d450df9b336b6f63b1d272cf86e3835392d99596ef8c35f206a457999'
            managed = json.loads(docker(['image','inspect',reference]).stdout)[0]
            assert managed['Id'] == args.managed_image
            subprocess.run(['docker','save','-o',str(archive),reference],check=True)
            docker(['load','-i',str(archive)],env=inner_env)
            docker(['tag',args.managed_image,'ghcr.io/sagernet/sing-box:v1.12.0'],env=inner_env)
            restored = json.loads(docker(['image','inspect',reference],env=inner_env).stdout)[0]
            assert restored['Id'] == managed['Id'] and restored['RootFS'] == managed['RootFS'] and restored['Config'] == managed['Config']
            (out/'managed-image-identity.json').write_text(json.dumps({'original':managed,'imported':restored},indent=2)+'\n')
        if args.control_image:
            assert args.managed_image, '控制平面场景要求受管镜像'
            original = json.loads(docker(['image','inspect',args.control_image]).stdout)[0]
            subprocess.run(['docker','save','-o',str(archive),args.control_image],check=True)
            docker(['load','-i',str(archive)],env=inner_env)
            restored = json.loads(docker(['image','inspect',args.control_image],env=inner_env).stdout)[0]
            assert all(restored[field] == original[field] for field in ['Id','RootFS','Config'])
            docker(['tag',args.control_image,'clearcc/hermit-control-e2e:fixture'],env=inner_env)
            (out/'control-image-identity.json').write_text(json.dumps({'original':original,'imported':restored},indent=2)+'\n')
        archive.unlink()
        prefix = ['/usr/bin/nsenter','--target',str(pid),'--net']
        for address in ['198.18.0.1/32','1.1.1.1/32','8.8.8.8/32']:
            subprocess.run(prefix+['ip','addr','add',address,'dev','lo'],check=True)
        audit = """import socket,json
checks=[]
for family,address in [(socket.AF_INET,('192.0.2.1',443)),(socket.AF_INET6,('2001:db8::1',443))]:
 with socket.socket(family) as stream:
  stream.settimeout(1); code=stream.connect_ex(address)
 assert code in (1,13,101,113)
 checks.append({'family':family,'denied':True,'errno':code})
print(json.dumps({'remote_egress':checks}))
"""
        isolation = subprocess.check_output(prefix+['python3','-c',audit],text=True)
        (out/'isolation.json').write_text(isolation)
        baseline = set(processes())
        env = {'PATH':str(args.node.parent)+':/usr/sbin:/usr/bin:/sbin:/bin','HOME':str(out),
            'DOCKER_HOST':inner_env['DOCKER_HOST'],'NODE_NO_WARNINGS':'1',
            'HERMIT_E2E_OAUTH':'1' if args.oauth else '',
            'HERMIT_E2E_SLOT_API_KEY':'1' if args.slot_api_key or args.oauth else '',
            'HERMIT_E2E_FACTORY':'1','HERMIT_E2E_FIXTURE_ROOT':str(fixture/'fixture'),
            'HERMIT_E2E_SING_BOX':str(args.sing_box.resolve()),'KIN_EGRESS_BIN':str(args.egress.resolve()),
            'HERMIT_E2E_MANAGED':'1' if args.managed_image else '',
            'HERMIT_E2E_CONTROL':'1' if args.control_image else '',
            'KIN_OS_REGISTRY':'127.0.0.1:1/hermit-fixture','KIN_COMPUTER_BIN':str(args.computer.resolve())}
        command = prefix+[str(args.node.resolve()),str(repo/'test/e2e/hermit-runtime.mjs'),str(out),
            str(args.archive.resolve()),str(args.receipt.resolve()),str(args.cli_source.resolve()),str(args.api_kernel.resolve())]
        completed = subprocess.run(command,env=env,capture_output=True,text=True,timeout=440 if args.slot_api_key or args.oauth else 260)
        (out/'driver.json').write_text(json.dumps({'exit_code':completed.returncode,'stdout':completed.stdout,'stderr':completed.stderr},indent=2)+'\n')
        summary = json.load(open(out/'summary.json')) if (out/'summary.json').exists() else {'result':'FAIL'}
        result = {'result':'PASS' if completed.returncode == 0 and summary['result']=='PASS' else 'FAIL','native':summary}
    except Exception as error:
        (out/'driver-error.json').write_text(json.dumps({'error':str(error),'traceback':traceback.format_exc()})+'\n')
    finally:
        subprocess.run(['docker','logs',name],stdout=open(out/'daemon.log','w'),stderr=subprocess.STDOUT)
        if sock.exists():
            for argv,filename in [(['ps','-a'],'inner-containers.txt'),(['network','ls'],'inner-networks.txt')]:
                value=subprocess.run(['docker',*argv],env=inner_env,capture_output=True,text=True)
                (out/filename).write_text(value.stdout+value.stderr)
            ids=subprocess.run(['docker','ps','-aq'],env=inner_env,capture_output=True,text=True).stdout.split()
            if ids: subprocess.run(['docker','rm','-f',*ids],env=inner_env,capture_output=True)
        remaining={pid:cmd for pid,cmd in processes().items() if pid not in baseline}
        (out/'processes-after-run.json').write_text(json.dumps(remaining,indent=2)+'\n')
        for pid in remaining:
            try:
                if os.readlink('/proc/'+str(pid)+'/ns/net') == namespace: os.kill(pid,signal.SIGKILL)
            except OSError: pass
        current=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
        if current.returncode == 0:
            assert json.loads(current.stdout)[0]['Config']['Labels'].get('hermit.e2e') == fixture.name
            docker(['rm','-fv',name])
        deadline=time.monotonic()+3
        while processes() and time.monotonic()<deadline: time.sleep(.05)
        unchanged=all(sha(repo/n)==h for n,h in pins.items())
        for n in pins:
            target=out/'sources'/n;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((repo/n).read_bytes())
        shutil.rmtree(fixture)
        result.update(source_unchanged=unchanged,namespace_gone=not processes(),unexpected_processes=remaining,
            daemon_removed=subprocess.run(['docker','inspect',name],capture_output=True).returncode!=0,
            fixture_removed=not fixture.exists(),sources=pins,image=args.image,dind_image=args.dind_image,managed_image=args.managed_image,control_image=args.control_image,
            binaries={n:sha(getattr(args,n)) for n in ['node','archive','cli_source','api_kernel','egress','sing_box','computer']})
        if remaining or not unchanged or not result['namespace_gone']: result['result']='FAIL'
        (out/'factory-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['sources','binaries']}))
    return 0 if result['result']=='PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
