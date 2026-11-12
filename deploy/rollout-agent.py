#!/usr/bin/env python3
"""认证 CI 通知并持久排队；worker 独立执行受保护的生产配置。"""
import argparse
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

from rollout import private, save, require, production_lock, Publisher, NoRedirect


def validate(config, event):
    require(event.get('schema') == 1, 'invalid_event')
    source = config['sources'].get(event.get('component'))
    require(source is not None and event.get('repository') == source['repository'], 'untrusted_repository')
    require(re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', event.get('tag', '')), 'stable_tag_required')
    require(re.fullmatch(r'[a-f0-9]{40}', event.get('commit', '')), 'invalid_commit')
    qualification = event.get('qualification', {})
    require(qualification.get('result') == 'PASS' and qualification.get('commit') == event['commit'] and qualification.get('migration') == 'compatible' and re.fullmatch(r'[a-f0-9]{64}', qualification.get('evidence_sha256', '')), 'qualification_required')
    if event['component'] != 'hermit':
        require(re.fullmatch(re.escape(source['image']) + r'@sha256:[a-f0-9]{64}', event.get('image', '')) and qualification.get('image') == event['image'], 'immutable_image_required')
        if event['component'] == 'sub2api':
            require(re.fullmatch(r'[a-f0-9]{64}', source.get('approved_migrations_sha256', '')) and qualification.get('migrations_sha256') == source['approved_migrations_sha256'], 'database_migration_review_required')
    else:
        package = event.get('hermit') or {}
        require(package.get('version') == event['tag'][1:] and package.get('commit') == event['commit'] and re.fullmatch(r'[a-f0-9]{64}', package.get('manifest_sha256', '')), 'fixed_package_required')
    return event['component'] + '-' + event['tag'] + '-' + event['commit'][:12]


def receive(config, port):
    spool = Path(config['spool']); spool.mkdir(parents=True, exist_ok=True, mode=0o700)
    secret = private(config['notification_secret_file']).encode()
    require(len(secret) >= 32, 'secret_too_short')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            stamp = self.headers.get('x-rollout-timestamp', '')
            expected = hmac.new(secret, (stamp + '.GET ' + self.path).encode(), hashlib.sha256).hexdigest()
            authorized = stamp.isdigit() and abs(time.time() - int(stamp)) <= 300 and hmac.compare_digest(expected, self.headers.get('x-rollout-signature', ''))
            status, value = 401, {'error': 'unauthorized'}
            if authorized:
                job_id = self.path.removeprefix('/events/')
                if self.path.startswith('/events/') and re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}', job_id) and not job_id.startswith('.') and (spool / job_id / 'event.json').exists():
                    file = spool / job_id / 'worker.json'
                    value = json.loads(file.read_text()) if file.exists() else {'state': 'queued'}
                    status = 200
                else:
                    status, value = 404, {'error': 'not_found'}
            data = json.dumps(value).encode()
            self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

        def do_POST(self):
            status, value = 400, {'error': 'invalid_event'}
            try:
                require(self.path == '/events', 'invalid_endpoint')
                length = int(self.headers.get('content-length', '0'))
                require(0 < length <= 65536, 'event_too_large')
                self.connection.settimeout(5)
                raw = self.rfile.read(length)
                stamp = self.headers.get('x-rollout-timestamp', '')
                signature = hmac.new(secret, stamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
                if not stamp.isdigit() or abs(time.time() - int(stamp)) > 300 or not hmac.compare_digest(signature, self.headers.get('x-rollout-signature', '')):
                    status, value = 401, {'error': 'unauthorized'}
                else:
                    event = json.loads(raw)
                    job_id = validate(config, event)
                    tag_file = spool / 'tags' / (event['component'] + '-' + event['tag'] + '.json')
                    if tag_file.exists() and json.loads(tag_file.read_text())['commit'] != event['commit']:
                        status, value = 409, {'error': 'tag_identity_changed'}
                    else:
                        file = spool / job_id / 'event.json'
                        if file.exists():
                            require(json.loads(file.read_text()) == event, 'event_identity_changed')
                        else:
                            save(tag_file, {'commit': event['commit']})
                            save(file, event)
                        status, value = 202, {'id': job_id, 'state': 'queued'}
            except (ValueError, KeyError, TypeError, OSError):
                pass
            data = json.dumps(value).encode()
            self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    server = HTTPServer(('127.0.0.1', port), Handler)
    print(json.dumps({'url': 'http://127.0.0.1:' + str(server.server_port)}), flush=True)
    server.serve_forever()


def prepare(config, event_file):
    event = json.loads(event_file.read_text())
    validate(config, event)
    directory = event_file.parent
    release_file, config_file = directory / 'release.json', directory / 'publisher.json'
    if release_file.exists() and config_file.exists():
        return config_file, release_file
    base = json.loads(private(config['publisher_config']))
    components_file = Path(config['spool']) / 'active-components.json'
    components = json.loads(components_file.read_text()) if components_file.exists() else config.get('initial_components', {})
    base['active_components_file'] = str(components_file)
    base['initial_components'] = config.get('initial_components', {})
    if event['component'] == 'sub2api':
        pointer = Path(base['state_dir']) / 'application-active.json'
        active = json.loads(pointer.read_text())['id'] if pointer.exists() else base['application_active']
        candidate = next(p for p in base['app_profiles'] if p['id'] != active)
        base['profiles'] = base['app_profiles']
    else:
        secret = private(base['secret_file'])
        req = urllib.request.Request(base['gateway_url'].rstrip('/') + '/_rollout/snapshot', headers={'Authorization': 'Bearer ' + secret})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as response:
            snapshot = json.load(response)
        active = next(g for g in snapshot['groups'] if g['id'] == snapshot['policy']['target'])
        occupied = {g['resources']['root'] for g in snapshot['groups'] if g['mode'] != 'retired'}
        candidates = [p for p in base['profiles'] if p['resources']['root'] not in occupied]
        require(candidates, 'no_spare_group_capacity')
        candidate = candidates[0]
        for profile in base['profiles']:
            if profile['resources']['root'] == active['resources']['root']:
                profile.update({k: active[k] for k in ['id', 'instance', 'url', 'artifact']})
        candidate['id'] = 'group-' + event['commit'][:16]
        candidate['instance'] = candidate['id'] + '-' + str(event.get('run_id', 0))
    image = event.get('image') or components.get('vm2api_image')
    require(image is not None, 'fixed_control_image_required')
    qualification = {**event['qualification'], 'image': image}
    release = {'schema': 1, 'id': event_file.parent.name, 'component': event['component'], 'commit': event['commit'], 'image': image, 'candidate': candidate['id'], 'qualification': qualification}
    if 'hermit' in event:
        release['hermit'] = event['hermit']
    elif event['component'] == 'vm2api':
        require(components.get('hermit') is not None, 'fixed_hermit_package_required')
        release['hermit'] = components['hermit']
    save(config_file, base); save(release_file, release)
    return config_file, release_file


def work(config):
    spool = Path(config['spool']); spool.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (spool / 'worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for file in sorted(spool.glob('*/event.json'), key=lambda p: p.stat().st_mtime):
            receipt = file.parent / 'worker.json'
            if receipt.exists() and json.loads(receipt.read_text()).get('state') in ['completed', 'failed', 'rolled_back']:
                continue
            try:
                config_file, release_file = prepare(config, file)
                publisher = Publisher(config_file, release_file)
                save(receipt, {'state': 'running', 'updated_at': time.time()})
                with production_lock(publisher.config):
                    code = publisher.apply()
                state = ('rolled_back' if publisher.task['state'] == 'rolled_back' else 'completed') if code == 0 else 'waiting'
                save(receipt, {'state': state, 'exit_code': code, 'updated_at': time.time()})
                if code == 2:
                    break
            except Exception as error:
                reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]{1,100}', str(error)) else type(error).__name__
                save(receipt, {'state': 'failed', 'code': 'operator_review_required', 'reason': reason, 'updated_at': time.time()})
                break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['receive', 'work'])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8791)
    args = parser.parse_args()
    config = json.loads(private(args.config))
    receive(config, args.port) if args.command == 'receive' else work(config)


if __name__ == '__main__':
    main()
