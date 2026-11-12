#!/usr/bin/env python3
"""仅发送当前成功 tag 的固定工件与端到端资格回执。"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
run = event['workflow_run']
repository = os.environ['GITHUB_REPOSITORY']
tag, commit = run.get('head_branch', ''), run.get('head_sha', '')
if run.get('conclusion') != 'success' or run.get('event') != 'push' or run.get('head_repository', {}).get('full_name') != repository or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
    raise SystemExit('Only a successful stable-tag release can request deployment')
if not re.fullmatch(r'[a-f0-9]{40}', commit):
    raise SystemExit('Invalid source identity')
component = os.environ['ROLLOUT_COMPONENT']
qualified = json.loads(Path(os.environ['ROLLOUT_QUALIFICATION']).read_text())
if qualified.get('result') != 'PASS' or qualified.get('commit') != commit:
    raise SystemExit('Missing source-bound qualification')
payload = {'schema': 1, 'component': component, 'repository': repository, 'tag': tag, 'commit': commit, 'run_id': run['id'], 'qualification': qualified}
if component == 'hermit':
    payload['hermit'] = json.loads(Path(os.environ['ROLLOUT_HERMIT_RECEIPT']).read_text())
else:
    payload['image'] = qualified['image']
endpoint = os.environ['ROLLOUT_ENDPOINT']
url = urllib.parse.urlsplit(endpoint)
if url.scheme != 'https' or not url.hostname or url.username or url.query or url.fragment:
    raise SystemExit('HTTPS endpoint required')
secret = os.environ['ROLLOUT_NOTIFICATION_SECRET'].strip().encode()
if len(secret) < 32:
    raise SystemExit('Notification secret too short')
raw = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
stamp = str(int(time.time()))
signature = hmac.new(secret, stamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
request = urllib.request.Request(endpoint, data=raw, headers={'Content-Type': 'application/json', 'X-Rollout-Timestamp': stamp, 'X-Rollout-Signature': signature})
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        raise ValueError('Redirect rejected')
with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
    if response.status != 202:
        raise SystemExit('Deployment queue rejected request')
    receipt = json.loads(response.read(65536))
Path('rollout-notification.json').write_text(json.dumps({'state': 'SUBMITTED', 'id': receipt['id'], 'commit': commit, 'tag': tag}, indent=2) + '\n')
print('Deployment queued; this is not a production success receipt')
deadline = time.monotonic() + 900
query = url.path.rstrip('/').removesuffix('/events') + '/events/' + receipt['id']
status_url = urllib.parse.urlunsplit((url.scheme, url.netloc, query, '', ''))
while time.monotonic() < deadline:
    stamp = str(int(time.time()))
    signature = hmac.new(secret, (stamp + '.GET /events/' + receipt['id']).encode(), hashlib.sha256).hexdigest()
    request = urllib.request.Request(status_url, headers={'X-Rollout-Timestamp': stamp, 'X-Rollout-Signature': signature})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        status = json.loads(response.read(65536))
    if status['state'] == 'completed':
        Path('rollout-notification.json').write_text(json.dumps({'state': 'DEPLOYED', 'id': receipt['id'], 'commit': commit, 'tag': tag}, indent=2) + '\n')
        print('Deployment completed and old version retired')
        break
    if status['state'] in ['failed', 'rolled_back']:
        raise SystemExit('Deployment did not complete; inspect the protected host receipt')
    time.sleep(5)
else:
    raise SystemExit('Deployment remains pending; old sessions were not forcibly stopped')
