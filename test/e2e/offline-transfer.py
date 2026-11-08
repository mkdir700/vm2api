#!/usr/bin/env python3
"""通过真实 SSH/SCP 验证内容缓存。远端只使用本次 /tmp 目录。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import traceback
import uuid


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--host',required=True);parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();repo=Path(__file__).resolve().parents[2]
    out=args.out.resolve();out.mkdir(parents=True,exist_ok=False)
    temp=Path(tempfile.mkdtemp(prefix='vm2api-transfer-'));remote=None;images=[];checks=[];result={'result':'FAIL'}
    def run(argv):
        p=subprocess.run(argv,capture_output=True,text=True,timeout=180)
        if p.returncode:raise RuntimeError('命令失败：'+p.stdout[-1000:]+p.stderr[-500:])
        return p.stdout.strip()
    def check(name,value):
        checks.append({'name':name,'result':'PASS' if value else 'FAIL'})
        if not value:raise RuntimeError(name)
    def stage(bundle):
        return json.loads(run(['python3',str(repo/'deploy/upgrade.py'),'apply','--release',str(bundle),'--host',args.host,'--root',remote,'--stage-only']))
    try:
        remote=run(['ssh',args.host,'mktemp -d /tmp/vm2api-transfer.XXXXXX'])
        assert re.fullmatch(r'/tmp/vm2api-transfer\.[A-Za-z0-9]+',remote)
        context=temp/'context';context.mkdir();(context/'payload').write_bytes(b'upgrade-cache-fixture\n'*50000)
        for index in [4,5]:
            revision=str(index)*40;image='vm2api-transfer-'+uuid.uuid4().hex+':fixture';images.append(image)
            (context/'Dockerfile').write_text('FROM scratch\nLABEL org.opencontainers.image.revision="'+revision+'"\nCOPY payload /payload\n')
            run(['docker','build','--platform','linux/amd64','--network','none','-t',image,str(context)])
            info=json.loads(run(['docker','image','inspect',image]))[0]
            acceptance={'format':'vm2api-offline-acceptance-1','result':'PASS','image_id':info['Id'],'source_revision':revision,'compatible_from':['sha256:'+'0'*64],'scenarios':[{'name':'transport-only-fixture','result':'PASS'}]}
            accepted=temp/'acceptance.json';accepted.write_text(json.dumps(acceptance))
            bundle=temp/str(index)
            run(['python3',str(repo/'deploy/upgrade.py'),'pack','--image',image,'--acceptance',str(accepted),'--output',str(bundle)])
            received=stage(bundle);(out/f'transfer-{index}.json').write_text(json.dumps(received,indent=2))
            check('真实SSH传输并暂存'+str(index),received['result']=='STAGED')
            if index==5:
                check('新发布复用相同镜像层',0<received['transferred_bytes']<sum(json.loads((bundle/'release.json').read_text())['objects'].values()))
                repeated=stage(bundle);check('相同发布不重复传对象',repeated['transferred_bytes']==0)
        result['result']='PASS'
    except Exception:(out/'error.txt').write_text(traceback.format_exc())
    finally:
        if remote:
            clean='import shutil;shutil.rmtree('+repr(remote)+')'
            subprocess.run(['ssh',args.host,shlex.join(['python3','-c',clean])],capture_output=True)
        for image in images:subprocess.run(['docker','image','rm',image],capture_output=True)
        shutil.rmtree(temp)
        result['checks']=checks;(out/'receipt.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result));return 0 if result['result']=='PASS' else 1

if __name__=='__main__':raise SystemExit(main())
