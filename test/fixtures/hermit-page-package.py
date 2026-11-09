#!/usr/bin/env python3
"""Generate a synthetic immutable package for HTTP and browser E2E checks."""
import io,json,tarfile,hashlib,sys
root,url,cli_sha=sys.argv[1:4]
elf=b'\x7fELF\x02\x01'+bytes(10)+b'\x02\x00\x3e\x00'+bytes(4076)
files={'bin/hermit':elf,**{'hooks/'+n:b'// fixture\n' for n in ['probe-native-input.mjs','probe-input-screening.mjs','probe-dispatch-gate.mjs','response-relay.mjs']}}
sha=lambda b:hashlib.sha256(b).hexdigest()
m={'schema_version':2,'runtime':'hermit','version':'0.1.0-ui-e2e','target':'linux-amd64','acceptance':'local-mock-only','slot_protocol':'vm2api-slot-1','entrypoints':{'kernel':{'path':'bin/hermit','args':['--mode','vm2api-slot']},'helper':{'path':'bin/hermit','args':['oauth']}},'cli':{'version':'2.1.318','platform':'linux-x64','bytes':4096,'sha256':cli_sha,'provisioning':'shared-cache','download_url':url},'dependencies':{'tmux':{'version':'3.4','sha256':'1'*64,'provisioning':'host'}},'capabilities':{'production':False,'helper_integration':False,'messages':True,'tools':True,'full_history_bootstrap':True,'cancel':True,'health':True},'validated_environment':{'distribution':'ubuntu','version_id':'24.04','libc':'glibc 2.39','architecture':'x86_64'},'files':{n:{'bytes':len(b),'sha256':sha(b),'mode':493 if n=='bin/hermit' else 420} for n,b in files.items()}}
m['capabilities'].update(system_prompt=True, eager_tool_streaming=True)
if len(sys.argv)>4 and sys.argv[4]=='production':
 m['version']='0.2.0-ui-e2e'
 m['acceptance']='production'
 m['entrypoints']['helper']={'transport':'internal-http','path':'/internal/v1/helper','protocol':'hermit-helper-1'}
 m['capabilities'].update(production=True, helper_integration=True, https_upstream=True, switch_readiness=True)
if 'pool' in sys.argv[5:]: m['capabilities']['native_session_pool']=True
raw=json.dumps(m,sort_keys=True).encode()
with tarfile.open(root+'/package.tar.gz','w:gz') as t:
 for n,b in {'manifest.json':raw,**files}.items():
  i=tarfile.TarInfo(n);i.size=len(b);i.mode=493 if n=='bin/hermit' else 420;t.addfile(i,io.BytesIO(b))
archive=open(root+'/package.tar.gz','rb').read()
json.dump({'archive':{'sha256':sha(archive),'bytes':len(archive)},'manifest_sha256':sha(raw)},open(root+'/release.json','w'))
