#!/usr/bin/env python3
"""把成功端到端回执绑定到当前源码与固定镜像。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal', '--', 'src', 'backend', 'deploy', 'scripts', 'internal', 'cmd', 'experiment', 'tools', 'package.json', 'package-lock.json', 'go.mod', 'go.sum'], text=True).strip():
    raise SystemExit('Source changed after checkout; qualification rejected')
directory = Path(os.environ['ROLLOUT_EVIDENCE'])
files = sorted(directory.rglob('summary.json'))
if not files:
    raise SystemExit('Missing end-to-end evidence')
hashes = {}
for file in files:
    value = json.loads(file.read_text())
    if value.get('result') != 'PASS' and value.get('passed') is not True:
        raise SystemExit('End-to-end qualification failed')
    if value.get('cleanup') is False or value.get('fixture_services_removed') is False:
        raise SystemExit('End-to-end cleanup failed')
    hashes[str(file.relative_to(directory))] = hashlib.sha256(file.read_bytes()).hexdigest()
data = {'result': 'PASS', 'commit': commit, 'migration': 'compatible', 'evidence_sha256': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()}
if os.environ.get('ROLLOUT_IMAGE'):
    data['image'] = os.environ['ROLLOUT_IMAGE']
if os.environ.get('ROLLOUT_COMPONENT') == 'sub2api':
    migrations = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path('backend/migrations').glob('*.sql'))}
    data['migrations_sha256'] = hashlib.sha256(json.dumps(migrations, sort_keys=True).encode()).hexdigest()
Path(os.environ['ROLLOUT_QUALIFICATION']).write_text(json.dumps(data, indent=2) + '\n')
