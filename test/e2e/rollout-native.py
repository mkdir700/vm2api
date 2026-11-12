#!/usr/bin/env python3
"""macOS 网络隔离：真实网关、两组 vm2api、两套 Hermit/CLI 与工具续接。"""
import argparse
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import traceback

REPO = Path(__file__).resolve().parents[2]
WORKSPACE = REPO.parent
sys.path.insert(0, str(WORKSPACE/'hermit/experiment'))
from outer_results import CLI, CLI_SHA, PROFILE
from owned_admission_e2e import sse


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['hermit', 'api-kernel', 'node', 'out', 'cleanup-helper']:
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.worker:
        args.out.mkdir(parents=True, exist_ok=False)
        profile = args.out/'isolation.sb'; profile.write_text(PROFILE)
        code = 1
        try:
            code = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), sys.executable, str(Path(__file__).resolve()), '--worker', *sum(([f'--{k}', str(getattr(args, k.replace('-', '_')).resolve())] for k in ['hermit', 'api-kernel', 'node', 'out', 'cleanup-helper']), [])], timeout=240).returncode
        finally:
            spec = importlib.util.spec_from_file_location('owned_cleanup', args.cleanup_helper)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            file = args.out/'owned-api-kernels.jsonl'
            receipts = [module.cleanup_api_kernel(json.loads(line)) for line in file.read_text().splitlines()] if file.exists() else []
            (args.out/'api-kernel-cleanup.json').write_text(json.dumps(receipts, indent=2))
            if any(r['result'] != 'PASS' for r in receipts): code = 1
        return code
    requests = []
    processes = {}
    owners = []
    result = 'FAIL'
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            if self.path == '/fixture/stop-old':
                process = processes['old']; process.stdin.close(); process.wait(timeout=20)
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'stopped': process.returncode == 0}).encode()); return
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            if self.headers.get('Content-Encoding') == 'gzip': raw = gzip.decompress(raw)
            body = json.loads(raw)
            history = json.dumps(body.get('messages', []))
            native_tool = next((tool['name'] for tool in body.get('tools', []) if str(tool.get('name', '')).startswith('mcp__outer__')), None)
            blocks = [{'type': 'tool_use', 'id': 'native_rollout_probe', 'name': native_tool, 'input': {'label': 'isolated'}}] if 'ROLLOUT_WAIT_TOOL' in history and 'tool_result' not in history and native_tool else []
            messages_path = self.path.split('?', 1)[0].endswith('/v1/messages')
            if messages_path:
                requests.append({'ordinal': len(requests)+1, 'tool_result': 'tool_result' in history, 'internal_header_present': bool(self.headers.get('x-kin-rollout-admission'))})
                data = sse(len(requests), blocks)
            else: data = b'{"input_tokens":10}'
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream' if messages_path else 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        assert sha(CLI) == CLI_SHA
        with tempfile.TemporaryDirectory(prefix='rollout-native-', dir='/private/tmp') as temp:
            area = Path(temp); hooks = WORKSPACE/'hermit/experiment'; token = 'isolated-native-rollout-token'
            secret_file = area/'secret'; secret_file.write_text('isolated-native-rollout-secret-at-least-32-bytes'); secret_file.chmod(0o600)
            sockets = {}
            for group in ['old', 'new']:
                socket = area/(group+'.sock'); sockets[group] = str(socket)
                root = area/(group+'-pool'); owners.append(root)
                config = {'socket': str(socket), 'internal_token': token, 'session_capacity': 2, 'session_idle_ttl_seconds': 600, 'session': {'root': str(root), 'managed': {'native_binary': str(CLI), 'native_sha256': CLI_SHA, 'tmux_binary': '/opt/homebrew/bin/tmux', 'tmux_sha256': sha('/opt/homebrew/bin/tmux'), 'hook_directory': str(hooks), 'hook_sha256': {n: sha(hooks/n) for n in ['probe-native-input.mjs','probe-input-screening.mjs','probe-dispatch-gate.mjs','response-relay.mjs']}, 'upstream_url': 'http://127.0.0.1:'+str(server.server_port), 'environment': ['ANTHROPIC_API_KEY=sk-ant-api03-isolated-native-rollout']}}}
                file = area/(group+'.json'); file.write_text(json.dumps(config)); file.chmod(0o600)
                processes[group] = subprocess.Popen([str(args.hermit), '--mode', 'vm2api-slot', '--config', str(file)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                deadline = time.monotonic()+15
                while not socket.exists():
                    assert processes[group].poll() is None and time.monotonic() < deadline
                    time.sleep(.025)
            config = {'root': str(area), 'out': str(args.out), 'secret_file': str(secret_file), 'token': token, 'sockets': sockets, 'provider': 'http://127.0.0.1:'+str(server.server_port), 'api_kernel': str(args.api_kernel), 'hermit_sha256': sha(args.hermit)}
            file = area/'driver.json'; file.write_text(json.dumps(config)); file.chmod(0o600)
            executed = subprocess.run([str(args.node), 'test/fixtures/rollout-native-chain.mjs', str(file)], cwd=REPO, capture_output=True, timeout=180)
            if executed.returncode:
                (args.out/'driver-stderr.txt').write_bytes(executed.stderr[-16000:])
                for group, process in processes.items():
                    if process.poll() is None: process.stdin.close(); process.wait(timeout=20)
                    (args.out/(group+'-native-stderr.txt')).write_bytes(process.stderr.read()[-12000:])
                diagnostics = []
                for root in owners:
                    for file in root.rglob('*.json'):
                        if any(word in file.name for word in ['incident', 'failure', 'readiness', 'owner']):
                            try:
                                row = json.loads(file.read_text())
                                diagnostics.append({'file': file.name, 'fields': {k: v for k, v in row.items() if k in ['phase', 'code', 'error', 'category', 'failure', 'reason', 'runtime_exit_code', 'groups_gone']}, 'events': row.get('events', [])})
                            except (ValueError, AttributeError): pass
                (args.out/'native-diagnostics.json').write_text(json.dumps(diagnostics, indent=2))
                events = []
                for root in owners:
                    for file in root.rglob('native-input-events.jsonl'):
                        for line in file.read_text().splitlines():
                            try:
                                row = json.loads(line)
                                if any(word in row.get('event','') for word in ['denied','error','failed','ready','catalog']):
                                    events.append({k: row[k] for k in ['event','reason','code','query_source','tool_catalog_count'] if k in row})
                            except ValueError: pass
                (args.out/'native-input-diagnostics.json').write_text(json.dumps(events, indent=2))
            assert executed.returncode == 0
            assert len(requests) == 4 and not any(r['internal_header_present'] for r in requests)
            result = 'PASS'
            (args.out/'pins.json').write_text(json.dumps({'hermit': sha(args.hermit), 'cli': CLI_SHA, 'node': sha(args.node), 'driver': sha(REPO/'test/fixtures/rollout-native-chain.mjs'), 'harness': sha(__file__)}, indent=2))
            for process in processes.values():
                if process.poll() is None: process.stdin.close(); process.wait(timeout=20)
            states = [json.loads(p.read_text()) for root in owners for p in root.glob('*/owner.json')]
            assert all(s.get('groups_gone') for s in states)
            (args.out/'owners-after-stop.json').write_text(json.dumps([{'groups_gone': s.get('groups_gone')} for s in states], indent=2))
    except Exception:
        result = 'FAIL'; (args.out/'failure.txt').write_text(traceback.format_exc())
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.stdin.close()
                try: process.wait(timeout=20)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        server.shutdown(); server.server_close()
        (args.out/'provider-boundary.json').write_text(json.dumps(requests, indent=2))
        (args.out/'summary.json').write_text(json.dumps({'result': result, 'boundary': '真实会话网关、两组 vm2api、两套 Hermit 原生池和固定 CLI；模型上游为本机模拟；无生产账号或部署', 'provider_requests': len(requests)}, ensure_ascii=False, indent=2))
    return 0 if result == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
