#!/usr/bin/env python3
"""真实 Hermit/CLI 的固定 slot、重复提交及前缀实验；真实上游须显式启用。"""
import argparse
import base64
import fcntl
import gzip
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback

WORKSPACE = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(WORKSPACE / 'hermit/experiment'))
from outer_results import PROFILE, CLI, CLI_SHA
from owned_admission_e2e import sse
from toolless_native_e2e import HOOKS

TOKEN = 'isolated-repeated-slot-internal-token'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def prefix(body):
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if k != 'cache_control'}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value
    return {key: hashlib.sha256(json.dumps(clean(body.get(key)), sort_keys=True,
                ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            for key in ['tools', 'system', 'messages']}


def usage(raw):
    result = {}
    for line in raw.decode().splitlines():
        if not line.startswith('data:'):
            continue
        try:
            item = json.loads(line[5:])
            result.update(item.get('message', {}).get('usage', {}))
            result.update(item.get('usage', {}))
        except ValueError:
            pass
    return result


REMOTE = r'''
import base64,json,sys,urllib.request,urllib.error
from pathlib import Path
request=json.load(sys.stdin)
credentials=json.loads(Path('/home/kincli/.claude/.credentials.json').read_text())
token=credentials['claudeAiOauth']['accessToken']
headers={k.lower():v for k,v in request['headers'].items() if k.lower() not in
 ['host','content-length','content-encoding','connection','x-api-key','authorization','accept-encoding']}
headers['Authorization']='Bearer '+token
headers['anthropic-version']='2023-06-01'
headers['x-app']='cli'
headers['anthropic-beta']=','.join(dict.fromkeys([x for x in headers.get('anthropic-beta','').split(',') if x]+['oauth-2025-04-20']))
data=json.dumps(request['body'],ensure_ascii=False).encode()
req=urllib.request.Request('https://api.anthropic.com/v1/messages?beta=true',data=data,headers=headers)
try:response=urllib.request.urlopen(req,timeout=100)
except urllib.error.HTTPError as error:response=error
raw=response.read(8*1024*1024).replace(token.encode(),b'<redacted>')
print(json.dumps({'status':response.status,'type':response.headers.get('Content-Type',''),
 'body':base64.b64encode(raw).decode(),'request_id':response.headers.get('request-id')}))
'''


def call(sock, route, body=None):
    conn = http.client.HTTPConnection('fixture', timeout=120)
    conn.sock = socket.socket(socket.AF_UNIX)
    conn.sock.settimeout(120)
    conn.sock.connect(str(sock))
    try:
        conn.request('GET' if body is None else 'POST', route,
                     None if body is None else json.dumps(body),
                     {'content-type': 'application/json', 'x-kin-internal-token': TOKEN})
        response = conn.getresponse()
        raw = response.read()
        return {'status': response.status, 'body': json.loads(raw)}
    finally:
        conn.close()


def worker(args):
    checks = []
    def check(name, ok):
        checks.append({'name': name, 'result': 'PASS' if ok else 'FAIL'})
        save(args.out/'worker-checks.json', checks)
        if not ok:
            raise AssertionError(name)
    with tempfile.TemporaryDirectory(prefix='repeat-slot-', dir='/private/tmp') as tmp:
        root = Path(tmp)
        sock = root/'slot.sock'
        hooks = WORKSPACE/'hermit/experiment'
        config = {'session_capacity': 3, 'session_idle_ttl_seconds': 600,
            'socket': str(sock), 'internal_token': TOKEN,
            'session': {'root': str(root/'owners'), 'managed': {
                'native_binary': str(args.cli), 'native_sha256': sha(args.cli),
                'tmux_binary': str(args.tmux), 'tmux_sha256': sha(args.tmux),
                'hook_directory': str(hooks), 'hook_sha256': {name: sha(hooks/name) for name in HOOKS},
                'upstream_url': args.provider,
                'environment': ['ANTHROPIC_API_KEY=sk-ant-api03-isolated-repeated-slot']}}}
        file = root/'slot.json'
        save(file, config)
        file.chmod(0o600)
        with (args.out/'native-stderr.txt').open('wb') as log:
            process = subprocess.Popen([str(args.hermit), '--mode', 'vm2api-slot', '--config', str(file)],
                stdin=subprocess.PIPE, stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+15
                while not sock.exists():
                    assert process.poll() is None and time.monotonic()<deadline, 'native startup'
                    time.sleep(.025)
                reference = '\n'.join(f'Record {i}: amber birch cedar delta elm frost green harbor iris jade kite lemon maple north oak pine.' for i in range(350))
                body = {'model': args.model, 'max_tokens': 128,
                    'system': [{'type': 'text', 'text': 'SYNTHETIC_REPEATED_SLOT_CACHE_EXPERIMENT\n'+reference,
                                'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}],
                    'messages': [{'role': 'user', 'content': 'Reply with exactly PONG. Do not call tools.'}]}
                replies = []
                for index, session in enumerate(['original', 'original', 'fresh-one', 'fresh-two']):
                    result = call(sock, '/internal/v1/messages', {'request_id': f'isolated-{index}',
                        'stream': False, 'headers': {'x-claude-code-session-id': session}, 'body': body})
                    replies.append({'session': session, **result})
                    save(args.out/'replies.json', replies)
                    if index == 1:
                        check('same_completed_execution_rejected', result['status'] == 409 and
                              result['body']['error']['code'] == 'completed_request_duplicate')
                    else:
                        check(f'execution_{index}_completed', result['status'] == 200)
                observed = call(sock, '/internal/session-cache')
                save(args.out/'native-cache.json', observed)
                rows = observed['body']['requests']
                successful = [row for row in rows if row['status'] == 200]
                check('three_successful_generations', len(successful) == 3)
                check('different_owners_inside_same_slot', len({row['native_owner'] for row in successful}) == 3)
                save(args.out/'slot-identity.json', {'slot': 'isolated-slot-a', 'kernel_socket_sha256':
                    hashlib.sha256(str(sock).encode()).hexdigest(), 'native_generation': observed['body'].get('generation'),
                    'cross_slot_dispatches': 0, 'owner_count': len(successful)})
            finally:
                if process.poll() is None:
                    process.stdin.close()
                    try:
                        process.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                owners = [json.loads(file.read_text()) for file in (root/'owners').glob('*/owner.json')]
                save(args.out/'cleanup.json', {'kernel_stopped': process.poll() is not None,
                    'owner_count': len(owners), 'all_process_groups_gone': bool(owners) and
                    all(owner.get('groups_gone') for owner in owners)})
                check('owned_process_groups_cleaned', bool(owners) and all(owner.get('groups_gone') for owner in owners))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermit', type=Path, required=True)
    parser.add_argument('--cli', type=Path, default=CLI)
    parser.add_argument('--tmux', type=Path, default=Path('/opt/homebrew/bin/tmux'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--model', default='claude-opus-5-5')
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--live-host', default='primaryserver')
    parser.add_argument('--live-container', default='kin-02')
    parser.add_argument('--live-budget-file', type=Path)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--provider')
    args = parser.parse_args()
    args.out = args.out.resolve()
    if args.worker:
        worker(args)
        return 0
    args.out.mkdir(parents=True, exist_ok=False)
    assert sha(args.cli) == CLI_SHA, 'wrong pinned CLI'
    captures, records, failures = [], [], []
    lock = threading.Lock()
    live_calls = 0
    budget_file = args.live_budget_file or args.out.parent/'live-budget.json'
    def reserve_live_request():
        budget_file.parent.mkdir(parents=True, exist_ok=True)
        with budget_file.open('a+') as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            file.seek(0)
            state = json.loads(file.read() or '{"used":0,"limit":6}')
            if state['used'] >= 6:
                raise RuntimeError('authorized live request budget exhausted')
            state['used'] += 1
            file.seek(0)
            file.truncate()
            json.dump(state, file)
            file.flush()
            os.fsync(file.fileno())
            return state['used']
    def invoke(body, headers, control=False):
        nonlocal live_calls
        if args.live:
            with lock:
                ordinal = reserve_live_request()
                live_calls += 1
            remote = subprocess.run(['ssh', '-o', 'BatchMode=yes', args.live_host, 'docker', 'exec', '-i',
                args.live_container, 'python3', '-c', "'"+REMOTE.replace("'", "'\\''")+"'"],
                input=json.dumps({'body': body, 'headers': headers}), text=True, capture_output=True, timeout=110)
            if remote.returncode:
                raise RuntimeError('isolated upstream forwarder failed: '+remote.stderr[-1200:])
            result = json.loads(remote.stdout)
            raw = base64.b64decode(result['body'])
        else:
            ordinal = len(records)+1
            result = {'status': 200, 'type': 'text/event-stream', 'request_id': f'mock-{ordinal}'}
            raw = sse(ordinal, []).replace(b'"claude-sonnet-4-6"', json.dumps(body['model']).encode())
        record = {'ordinal': ordinal, 'control': control, 'status': result['status'],
            'request_id': result.get('request_id'), 'prefix': prefix(body), 'usage': usage(raw),
            'source': 'real-provider' if args.live else 'mock-provider'}
        with lock:
            records.append(record)
            save(args.out/'provider-receipt.json', records)
        return result['status'], result['type'], raw
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            if self.headers.get('Content-Encoding') == 'gzip':
                raw = gzip.decompress(raw)
            body = json.loads(raw)
            if self.path.split('?')[0].endswith('/v1/messages'):
                captures.append((body, dict(self.headers)))
                save(args.out/'synthetic-provider-bodies.json', [body for body, _ in captures])
                try:
                    status, kind, data = invoke(body, dict(self.headers))
                except Exception as error:
                    failures.append(str(error))
                    status, kind, data = 502, 'application/json', json.dumps({'error': {'type': 'api_error', 'message': str(error)}}).encode()
            else:
                status, kind, data = 200, 'application/json', b'{"input_tokens":10000}'
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    code = 1
    try:
        profile = args.out/'isolation.sb'
        profile.write_text(PROFILE)
        command = ['/usr/bin/sandbox-exec', '-f', str(profile), sys.executable, str(Path(__file__).resolve()),
            '--worker', '--hermit', str(args.hermit.resolve()), '--cli', str(args.cli.resolve()),
            '--tmux', str(args.tmux.resolve()), '--out', str(args.out), '--model', args.model,
            '--provider', f'http://127.0.0.1:{server.server_port}']
        result = subprocess.run(command, capture_output=True, timeout=420)
        (args.out/'worker-stderr.txt').write_bytes(result.stderr[-12000:])
        code = result.returncode
        if args.live and code == 0 and len(captures) == 3:
            for _ in range(2):
                invoke(captures[0][0], captures[0][1], control=True)
        source = {'hermit': sha(args.hermit), 'cli': sha(args.cli), 'tmux': sha(args.tmux),
            'harness': sha(__file__), 'vm2api': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=WORKSPACE/'vm2api', text=True).strip(),
            'hermit_source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=WORKSPACE/'hermit', text=True).strip()}
        save(args.out/'pins.json', source)
        native = [row for row in records if not row['control']]
        summary = {'worker_exit_code': code, 'mode': 'live' if args.live else 'isolated-mock',
            'live_calls': live_calls, 'authorized_live_limit': 6 if args.live else 0,
            'actual_provider_requests': len(native), 'prefixes_identical': len(native) == 3 and
                all(row['prefix'] == native[0]['prefix'] for row in native),
            'real_cache_verified': args.live and len(native) == 3 and
                all(row['status'] == 200 and row['usage'].get('cache_read_input_tokens', 0) > 0 for row in native[1:]),
            'failures': failures}
        save(args.out/'summary.json', summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    except Exception:
        (args.out/'failure.txt').write_text(traceback.format_exc())
        raise
    finally:
        server.shutdown()
        server.server_close()
    return code


if __name__ == '__main__':
    raise SystemExit(main())
