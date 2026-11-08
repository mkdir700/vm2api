#!/usr/bin/env python3
"""构建离线发布包，并通过同一个独立执行器升级安装。"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('upgrade_executor', HERE/'upgrade_executor.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def call(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=1800, **kwargs)
    if result.returncode:
        raise RuntimeError('外部命令失败：'+argv[0]+' '+(argv[1] if len(argv)>1 else ''))
    return result.stdout


def store(output, source):
    digest = engine.sha(source)
    target = output/'objects'/digest
    if not target.exists(): shutil.copyfile(source, target)
    return digest


def pack(args):
    output = args.output.resolve()
    if output.exists(): raise ValueError('发布目录已存在')
    receipts=[(file,json.loads(file.read_text())) for file in args.acceptance]
    acceptance=receipts[0][1]
    image = json.loads(call(['docker','image','inspect',args.image]))[0]
    revision = image['Config'].get('Labels',{}).get('org.opencontainers.image.revision','')
    if not re.fullmatch('[0-9a-f]{40}',revision): raise ValueError('镜像缺少固定源码提交')
    if image['Os']!='linux' or image['Architecture']!='amd64': raise ValueError('首版只接受 Linux AMD64 镜像')
    if acceptance.get('format')!='vm2api-offline-acceptance-1':
        scenarios=[];archives=set()
        for file,receipt in receipts:
            if not (receipt.get('result')=='PASS' and receipt.get('control_image')==image['Id'] and receipt.get('native',{}).get('result')=='PASS'
                    and all(receipt.get(k) is True for k in ['source_unchanged','namespace_gone','daemon_removed','fixture_removed']) and not receipt.get('unexpected_processes')):
                raise ValueError('完整验收收据没有通过，或使用了其他控制镜像')
            scenarios.append({'name':file.parent.name,'result':'PASS','receipt_sha256':engine.sha(file)})
            if receipt.get('binaries',{}).get('archive'):archives.add(receipt['binaries']['archive'])
        if len(archives)>1:raise ValueError('验收使用了不同的 Hermit 包')
        acceptance={'format':'vm2api-offline-acceptance-1','result':'PASS','image_id':image['Id'],'source_revision':revision,'compatible_from':args.compatible_from,'scenarios':scenarios}
        if archives:acceptance['hermit_archive_sha256']=archives.pop()
    elif len(receipts)!=1:raise ValueError('统一收据不能与其他收据混用')
    if not (acceptance.get('format')=='vm2api-offline-acceptance-1' and acceptance.get('result')=='PASS'
            and acceptance.get('image_id')==image['Id'] and acceptance.get('source_revision')==revision
            and acceptance.get('scenarios') and all(x.get('result')=='PASS' for x in acceptance['scenarios'])
            and acceptance.get('compatible_from')):
        raise ValueError('验收收据与镜像不匹配，或未声明兼容的来源镜像')
    output.mkdir(parents=True,mode=0o700);(output/'objects').mkdir()
    try:
        with tempfile.TemporaryDirectory(prefix='vm2api-pack-') as temp:
            saved = Path(temp)/'image.tar'
            ref = 'local/vm2api-offline:'+revision
            call(['docker','tag',image['Id'],ref])
            call(['docker','save','-o',str(saved),ref])
            members=[]
            with tarfile.open(saved) as archive:
                entries = json.load(archive.extractfile('manifest.json'))
                configs = [archive.extractfile(x['Config']).read() for x in entries]
                config = next(c for c in configs if json.loads(c).get('rootfs',{}).get('diff_ids')==image['RootFS']['Layers'])
                for item in archive:
                    if item.isdir():continue
                    if not item.isfile() or not engine.safe_relative(item.name):raise ValueError('Docker 归档包含非法条目')
                    file=Path(temp)/'member'
                    with archive.extractfile(item) as src, file.open('wb') as dst:shutil.copyfileobj(src,dst)
                    members.append({'name':item.name,'sha256':store(output,file),'size':item.size,'mode':item.mode})
            executor=output/'executor.py';shutil.copyfile(HERE/'upgrade_executor.py',executor)
            manifest={'format':'vm2api-offline-release-1','source_revision':revision,
                'image':{'id':image['Id'],'config_id':'sha256:'+hashlib.sha256(config).hexdigest(),'ref':ref,'architecture':'amd64','layers':image['RootFS']['Layers'],'members':members},
                'executor_sha256':engine.sha(executor),'acceptance':acceptance,'evidence':[store(output,file) for file,_ in receipts],'hermit':None}
            if args.hermit_package:
                package=args.hermit_package.resolve();receipt=json.loads((package/'release.json').read_text())
                name=receipt['archive']['name']
                if not engine.safe_relative(name) or '/' in name:raise ValueError('Hermit 归档文件名无效')
                archive=package/name
                if engine.sha(archive)!=receipt['archive']['sha256'] or archive.stat().st_size!=receipt['archive']['bytes']:raise ValueError('Hermit 归档与收据不匹配')
                if acceptance.get('hermit_archive_sha256')!=receipt['archive']['sha256']:raise ValueError('Hermit 包未绑定到验收')
                manifest['hermit']={'receipt':receipt,'object':store(output,archive)}
                with tarfile.open(archive) as tar:
                    member=tar.getmember('manifest.json')
                    if not member.isfile() or member.size>1024*1024:raise ValueError('Hermit 清单无效')
                    raw=tar.extractfile(member).read()
                if hashlib.sha256(raw).hexdigest()!=receipt['manifest_sha256']:raise ValueError('Hermit 清单摘要不匹配')
                manifest['hermit']['manifest']=json.loads(raw)
                if args.cli:
                    cli=json.loads(raw)['cli']
                    if engine.sha(args.cli)!=cli['sha256'] or args.cli.stat().st_size!=cli['bytes']:raise ValueError('CLI 摘要不匹配')
                    manifest['hermit']['cli_object']=store(output,args.cli)
            elif acceptance.get('hermit_archive_sha256'):raise ValueError('验收绑定的 Hermit 包缺失')
            manifest['objects']={f.name:f.stat().st_size for f in sorted((output/'objects').iterdir())}
            engine.atomic_json(output/'release.json',manifest)
            engine.verify_release(output)
            print(json.dumps({'result':'PASS','release':str(output),'image':image['Id'],'objects':len(manifest['objects'])}))
    except Exception:
        shutil.rmtree(output)
        raise


def build(args):
    repo=HERE.parent
    if call(['git','status','--porcelain','--untracked-files=no'],cwd=repo).strip():raise ValueError('构建前请提交跟踪文件的改动')
    revision=call(['git','rev-parse','HEAD'],cwd=repo).strip()
    image='local/vm2api-build:'+revision
    with tempfile.TemporaryDirectory(prefix='vm2api-source-') as temp:
        archive=Path(temp)/'source.tar'
        subprocess.run(['git','archive','--format=tar','-o',str(archive),revision],cwd=repo,check=True)
        source=Path(temp)/'source';source.mkdir()
        with tarfile.open(archive) as tar:tar.extractall(source,filter='data')
        subprocess.run(['docker','build','--platform','linux/amd64','--label','org.opencontainers.image.revision='+revision,'-t',image,str(source)],check=True)
    print(json.dumps({'result':'BUILT','image':image,'source_revision':revision,'next':'完成验收后运行 pack'}))


def apply(args):
    release=args.release.resolve();manifest=engine.verify_release(release)
    root=args.root.resolve()
    if args.host:
        if not re.fullmatch(r'[A-Za-z0-9_@.:-]+',args.host) or args.host.startswith('-'):raise ValueError('SSH 主机无效')
        remote_root=str(args.root)
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+',remote_root) or '..' in args.root.parts:raise ValueError('远端安装路径不受支持')
        if not args.root.is_absolute():raise ValueError('远端安装目录应为绝对路径')
        release_id=engine.sha(release/'release.json')
        remote=str(args.root/'.upgrades/releases'/release_id)
        setup="import pathlib,os; os.umask(0o077); r=pathlib.Path("+repr(remote)+"); c=pathlib.Path("+repr(str(args.root/'.upgrades/objects'))+"); c.mkdir(parents=True,exist_ok=True); r.mkdir(parents=True,exist_ok=True); o=r/'objects'; o.symlink_to(c) if not o.exists() else None; assert o.resolve()==c.resolve()"
        call(['ssh',args.host,shlex.join(['python3','-c',setup])])
        # 内容寻址对象按摘要复用；接收端重新核对，不信任文件名。
        probe="import pathlib,json,hashlib; p=pathlib.Path("+repr(remote+'/objects')+"); print(json.dumps({f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in p.iterdir() if f.is_file()}))"
        present=json.loads(call(['ssh',args.host,shlex.join(['python3','-c',probe])]))
        missing=[n for n in manifest['objects'] if present.get(n)!=n]
        for i in range(0,len(missing),20):
            call(['scp',*[str(release/'objects'/n) for n in missing[i:i+20]],args.host+':'+shlex.quote(remote+'/objects/')])
        call(['scp',str(release/'release.json'),str(release/'executor.py'),str(Path(__file__).resolve()),args.host+':'+shlex.quote(remote+'/')])
        # upgrade.py 与 executor.py 使用固定同目录名字。
        call(['ssh',args.host,shlex.join(['cp',remote+'/executor.py',remote+'/upgrade_executor.py'])])
        if args.stage_only:
            print(json.dumps({'result':'STAGED','release':remote,'transferred_objects':len(missing),'transferred_bytes':sum(manifest['objects'][n] for n in missing)}));return
        command=['python3',remote+'/upgrade.py','apply','--release',remote,'--root',remote_root,'--project',args.project,'--container',args.container]
        print(call(['ssh',args.host,shlex.join(command)]).strip())
        return
    if args.stage_only:raise ValueError('--stage-only 需要 --host')
    engine.start(release,root,args.project,args.container,args.wait)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('build')
    p=commands.add_parser('pack');p.add_argument('--image',required=True);p.add_argument('--acceptance',type=Path,required=True,action='append');p.add_argument('--compatible-from',action='append',default=[]);p.add_argument('--output',type=Path,required=True);p.add_argument('--hermit-package',type=Path);p.add_argument('--cli',type=Path)
    p=commands.add_parser('apply');p.add_argument('--release',type=Path,required=True);p.add_argument('--root',type=Path,required=True);p.add_argument('--project',default='vm2api');p.add_argument('--container',default='vm2api');p.add_argument('--host');p.add_argument('--stage-only',action='store_true');p.add_argument('--wait',action='store_true')
    p=commands.add_parser('status');p.add_argument('--root',type=Path,required=True)
    p=commands.add_parser('recover');p.add_argument('--root',type=Path,required=True);p.add_argument('--wait',action='store_true')
    args=parser.parse_args()
    try:
        if args.command=='build':build(args)
        elif args.command=='pack':pack(args)
        elif args.command=='apply':apply(args)
        elif args.command=='recover':engine.recover(args.root,args.wait)
        else:
            p=args.root/'.upgrades/current.json';print(p.read_text() if p.exists() else json.dumps({'result':'NOT_RUN'}))
        return 0
    except Exception as error:
        print(json.dumps({'result':'FAIL','error':str(error)}))
        return 1

if __name__=='__main__':raise SystemExit(main())
