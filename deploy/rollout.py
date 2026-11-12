#!/usr/bin/env python3
"""单宿主机会话发布器。生产锁、固定 Compose、持久事务与保守排空。"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent


def require(ok, code):
    if not ok:
        raise ValueError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.pending')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0, 'private_file_required')
    return path.read_text().strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        raise ValueError('redirect_rejected')


class Publisher:
    def __init__(self, config_file, release_file):
        self.config = json.loads(private(config_file))
        self.release = json.loads(Path(release_file).read_text())
        c, r = self.config, self.release
        require(c.get('schema') == 1 and r.get('schema') == 1, 'invalid_schema')
        require(re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}', r.get('id', '')) and not r['id'].startswith('.'), 'invalid_release_id')
        require(r.get('component') in ['vm2api', 'hermit', 'sub2api'], 'invalid_component')
        require(re.fullmatch(r'[0-9a-f]{40}', r.get('commit', '')), 'invalid_source')
        require(re.fullmatch(r'[a-z0-9./_-]+@sha256:[a-f0-9]{64}', r.get('image', '')), 'immutable_image_required')
        qualification = r.get('qualification', {})
        require(qualification.get('result') == 'PASS' and qualification.get('commit') == r['commit'] and qualification.get('image') == r['image'] and qualification.get('migration') == 'compatible', 'qualification_required')
        self.secret = private(c['secret_file'])
        require(len(self.secret.encode()) >= 32, 'secret_too_short')
        base = urllib.parse.urlsplit(c['gateway_url'])
        require(base.scheme == 'http' and base.hostname in ['127.0.0.1', '::1'] and not base.username and not base.query and base.path in ['', '/'], 'loopback_gateway_required')
        self.file = Path(c['state_dir']) / r['id'] / 'task.json'
        self.task = json.loads(self.file.read_text()) if self.file.exists() else None
        if self.task:
            require(self.task['release'] == r and self.task['config_digest'] == digest(c), 'task_identity_changed')
        self.docker = c.get('docker_bin', 'docker')

    def command(self, *args, timeout=120):
        proc = subprocess.run([self.docker, *args], capture_output=True, text=True, timeout=timeout)
        require(proc.returncode == 0, 'docker_operation_failed')
        return proc.stdout

    def api(self, route, body=None, base=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request((base or self.config['gateway_url']).rstrip('/') + '/_rollout/' + route, data=data, headers={'Authorization': 'Bearer ' + self.secret, 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as res:
            raw = res.read(262145)
            require(len(raw) <= 262144, 'response_too_large')
            return json.loads(raw)

    def profile(self, group):
        found = [p for p in self.config['profiles'] if p['id'] == group]
        require(len(found) == 1, 'profile_not_found')
        return found[0]

    def event(self, state, **extra):
        if state == 'prepared' and 'previous_components' not in self.task:
            file = self.config.get('active_components_file')
            self.task['previous_components'] = json.loads(Path(file).read_text()) if file and Path(file).exists() else self.config.get('initial_components', {})
        self.task.update(state=state, updated_at=time.time(), **extra)
        if state in ['completed', 'rolled_back'] and self.config.get('active_components_file'):
            self.save_components(state)
        save(self.file, self.task)

    def save_components(self, state):
        file = Path(self.config['active_components_file'])
        value = json.loads(file.read_text()) if file.exists() else dict(self.config.get('initial_components', {}))
        component = self.release['component']
        fields = ['sub2api_image'] if component == 'sub2api' else ['vm2api_image', 'hermit']
        if state == 'rolled_back':
            for key in fields:
                if key in self.task['previous_components']:
                    value[key] = self.task['previous_components'][key]
                else:
                    value.pop(key, None)
        else:
            value['sub2api_image' if component == 'sub2api' else 'vm2api_image'] = self.release['image']
            if 'hermit' in self.release:
                value['hermit'] = self.release['hermit']
        save(file, value)

    def identities(self, profile):
        records = json.loads(self.command('inspect', *profile['resources']['containers']))
        return {r['Name'].lstrip('/'): r['Id'] for r in records}

    def start(self, profile):
        root = Path(profile['resources']['root'])
        require(root.is_absolute() and not root.is_symlink(), 'absolute_group_root_required')
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        application = self.release['component'] == 'sub2api'
        secret_file = self.config['secret_file']
        if application:
            # sub2api 入口会降权到 UID 1000。副本留在 root 私有目录内。
            token = self.file.parent / 'application-token'
            token.write_text(self.secret + '\n'); token.chmod(0o600)
            self.command('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', '/bin/sh', '-v', str(token) + ':/run/rollout-token', self.release['image'], '-c', 'chown 1000:1000 /run/rollout-token && chmod 600 /run/rollout-token')
            secret_file = str(token)
        env = {
            'ROLLOUT_IMAGE': self.release['image'], 'ROLLOUT_CONTAINER': profile['resources']['containers'][0],
            'ROLLOUT_SERVICE_ENV': profile['service_env'], 'ROLLOUT_ROOT': str(root), 'ROLLOUT_PORT': str(profile['port']),
            'ROLLOUT_GROUP': profile['id'], 'ROLLOUT_INSTANCE': profile['instance'],
            'ROLLOUT_AUTHORITY': profile.get('authority_dir', ''), 'ROLLOUT_SECRET_FILE': secret_file,
            'ROLLOUT_NETWORK': profile.get('network', ''),
        }
        private(profile['service_env'])
        env_file = self.file.parent / 'compose.env'
        for value in env.values():
            require(not any(c in value for c in '\r\n\x00\"\\$'), 'unsafe_compose_value')
        env_file.write_text(''.join(f'{k}="{v}"\n' for k, v in env.items()))
        env_file.chmod(0o600)
        argv = ['compose', '--project-name', profile['project'], '--project-directory', str(root), '--env-file', str(env_file), '-f', str(HERE / ('rollout-application-compose.yml' if application else 'rollout-compose.yml'))]
        self.command(*argv, 'config', '--quiet')
        self.command(*argv, 'up', '-d', '--no-deps', 'app' if application else 'vm2api')

    def ready(self, profile):
        deadline = time.monotonic() + self.config.get('ready_timeout_seconds', 60)
        while True:
            try:
                proof = self.api('status', base=profile['url'])
                if proof.get('ready') is True and proof.get('group') == profile['id'] and proof.get('instance') == profile['instance']:
                    return proof
            except (OSError, ValueError):
                pass
            require(time.monotonic() < deadline, 'candidate_not_ready')
            time.sleep(.1)

    def apply(self):
        if self.release['component'] == 'sub2api':
            return self.apply_application()
        require(self.release['component'] in ['vm2api', 'hermit'], 'application_adapter_required')
        candidate = self.profile(self.release['candidate'])
        if not self.task:
            snapshot = self.api('snapshot')
            old = snapshot['policy']['target']
            require(old and old != candidate['id'], 'existing_group_required')
            old_profile = self.profile(old)
            self.task = {'release': self.release, 'config_digest': digest(self.config), 'old': old, 'candidate': candidate['id'], 'initial_generation': snapshot['policy']['generation'], 'old_containers': self.identities(old_profile), 'state': 'prepared'}
            self.event('prepared')
        if self.task['state'] in ['completed', 'rolled_back']:
            return 0
        if self.task['state'] in ['gateway_waiting', 'gateway_draining']:
            code = self.finish_gateway(False)
            if code == 0: self.event('completed')
            return code
        if self.task['state'] == 'prepared':
            self.command('pull', self.release['image'])
            image = json.loads(self.command('image', 'inspect', self.release['image']))[0]
            if self.release['component'] == 'vm2api':
                require(image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == self.release['commit'], 'image_source_mismatch')
            if self.release.get('hermit'):
                self.install_hermit(candidate)
            self.event('artifact_ready')
        if self.task['state'] == 'artifact_ready':
            if self.release['component'] == 'vm2api' and self.config.get('gateway_profiles'):
                self.prepare_gateway()
            self.start(candidate)
            self.task['candidate_containers'] = self.identities(candidate)
            self.ready(candidate)
            spec = {k: candidate[k] for k in ['id', 'url', 'instance', 'resources']}
            spec['artifact'] = candidate.get('artifact', self.release['image'].split('@')[1])
            self.api('groups', spec)
            self.event('candidate_ready')
        if self.task['state'] == 'candidate_ready':
            policy = self.api('snapshot')['policy']
            if policy['target'] == candidate['id'] and policy['generation'] == self.task['initial_generation'] + 1:
                pass  # 策略已成功但发布器尚未保存阶段。
            else:
                self.api('policy', {'target': candidate['id'], 'expected_generation': self.task['initial_generation']})
            self.event('draining', generation=self.task['initial_generation'] + 1)
        if self.task['state'] in ['draining', 'waiting']:
            return self.finish(self.task['old'], self.task['generation'], 'completed')
        require(False, 'unknown_task_state')

    def finish(self, old, generation, terminal):
        deadline = time.monotonic() + self.config.get('drain_timeout_seconds', 600)
        while True:
            snapshot = self.api('snapshot')
            require(snapshot['policy']['generation'] == generation and snapshot['policy']['target'] != old, 'policy_changed_during_drain')
            try:
                active = self.profile(snapshot['policy']['target'])
                proof = self.api('status', base=active['url'])
                require(proof.get('ready') is True and proof.get('instance') == active['instance'] and proof.get('group') == active['id'], 'active_candidate_unhealthy')
            except Exception:
                if terminal == 'completed':
                    return self.rollback()
                raise ValueError('rollback_target_unavailable') from None
            group = next(g for g in snapshot['groups'] if g['id'] == old)
            if group['mode'] == 'retired':
                break
            proof = self.api('drain/' + old)
            self.event('draining' if terminal == 'completed' else 'rollback_draining', last_drain=proof)
            if proof.get('drained') is True:
                self.api('retire', {'group': old, 'expected_generation': generation})
                break
            if time.monotonic() >= deadline:
                self.event('waiting' if terminal == 'completed' else 'rollback_waiting')
                return 2
            time.sleep(.2)
        profile = self.profile(old)
        expected = self.task['old_containers'] if old == self.task['old'] else self.task.get('candidate_containers')
        actual = self.identities(profile)
        if expected:
            require(actual == expected, 'container_identity_changed')
        self.command('stop', '--time', '30', *profile['resources']['containers'])
        if self.task.get('gateway'):
            code = self.finish_gateway(terminal == 'rolled_back')
            if code: return code
        self.event(terminal)
        return 0

    def rollback(self):
        if self.release['component'] == 'sub2api':
            return self.rollback_application()
        require(self.task is not None, 'task_not_found')
        if self.task['state'] == 'rolled_back':
            return 0
        if self.task['state'] in ['gateway_rollback_waiting', 'gateway_rollback_draining']:
            code = self.finish_gateway(True)
            if code == 0: self.event('rolled_back')
            return code
        if self.task['state'] not in ['rollback_prepared', 'rollback_draining', 'rollback_waiting']:
            old = self.profile(self.task['old'])
            if self.task.get('gateway'):
                self.restore_gateway()
            require(self.identities(old) == self.task['old_containers'], 'rollback_container_identity_changed')
            self.command('start', *reversed(old['resources']['containers']))
            self.ready(old)
            policy = self.api('snapshot')['policy']
            require(policy['target'] == self.task['candidate'], 'rollback_source_changed')
            self.task['candidate_containers'] = self.identities(self.profile(self.task['candidate']))
            self.event('rollback_prepared', rollback_generation=policy['generation'] + 1)
        if self.task['state'] == 'rollback_prepared':
            policy = self.api('snapshot')['policy']
            if policy['target'] != self.task['old']:
                self.api('policy', {'target': self.task['old'], 'expected_generation': self.task['rollback_generation'] - 1})
            else:
                require(policy['generation'] == self.task['rollback_generation'], 'rollback_generation_changed')
            self.event('rollback_draining')
        return self.finish(self.task['candidate'], self.task['rollback_generation'], 'rolled_back')

    def install_hermit(self, profile):
        package = self.release.get('hermit') or {}
        require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?', package.get('version', '')), 'fixed_hermit_version_required')
        require(re.fullmatch(r'[a-f0-9]{40}', package.get('commit', '')), 'hermit_source_required')
        if self.release['component'] == 'hermit':
            require(package.get('commit') == self.release['commit'], 'hermit_source_mismatch')
        for name in profile['resources']['containers']:
            proc = subprocess.run([self.docker, 'inspect', name], capture_output=True, text=True, timeout=20)
            if proc.returncode == 0:
                records = json.loads(proc.stdout)
                require(all(r.get('State', {}).get('Running') is False for r in records), 'candidate_must_be_stopped_for_install')
            else:
                require('No such' in proc.stderr, 'candidate_state_unconfirmed')
        subprocess.run([self.config.get('node_bin', 'node'), str(HERE / 'rollout-hermit.mjs'), profile['resources']['root'], json.dumps(package)], check=True, timeout=180, stdout=subprocess.DEVNULL)

    def gateway_ids(self, profile):
        return {r['Name'].lstrip('/'): r['Id'] for r in json.loads(self.command('inspect', profile['container']))}

    def prepare_gateway(self):
        if 'gateway' not in self.task:
            pointer = Path(self.config['state_dir']) / 'gateway-active.json'
            active = json.loads(pointer.read_text()) if pointer.exists() else {'id': self.config['gateway_active']}
            old = next(dict(p) for p in self.config['gateway_profiles'] if p['id'] == active['id'])
            if active.get('instance'): old['instance'] = active['instance']
            candidate = next(dict(p) for p in self.config['gateway_profiles'] if p['id'] != old['id'])
            candidate['instance'] = 'gateway-' + digest(self.release)[:24]
            self.task['gateway'] = {'old': old, 'candidate': candidate, 'old_ids': self.gateway_ids(old), 'drain_confirmed': {}}
            self.event(self.task['state'])
        transaction = self.task['gateway']
        if transaction.get('ready'): return
        candidate = transaction['candidate']
        private(self.config['gateway_env'])
        env = {'ROLLOUT_IMAGE': self.release['image'], 'ROLLOUT_GATEWAY_CONTAINER': candidate['container'], 'ROLLOUT_GATEWAY_ENV': self.config['gateway_env'], 'ROLLOUT_GATEWAY_PORT': str(self.config.get('gateway_port', 8790)), 'ROLLOUT_GATEWAY_ADMIN_PORT': str(candidate['admin_port']), 'ROLLOUT_GATEWAY_INSTANCE': candidate['instance'], 'ROLLOUT_GATEWAY_AUTHORITY': self.config['gateway_authority_dir'], 'ROLLOUT_SECRET_FILE': self.config['secret_file']}
        file = self.file.parent / 'gateway.env'
        for value in env.values(): require(not any(c in value for c in '\r\n\x00\"\\$'), 'unsafe_compose_value')
        file.write_text(''.join(f'{k}="{v}"\n' for k,v in env.items())); file.chmod(0o600)
        argv = ['compose', '--project-name', candidate['id'], '--env-file', str(file), '-f', str(HERE/'rollout-gateway-compose.yml')]
        self.command(*argv, 'config', '--quiet'); self.command(*argv, 'up', '-d', '--no-deps', 'gateway')
        deadline = time.monotonic()+self.config.get('ready_timeout_seconds',60)
        while True:
            try:
                status=self.api('gateway/status',base=candidate['admin_url'])
                if status.get('schema') == 1 and status.get('authority_schema') == 1 and status.get('instance') == candidate['instance'] and status.get('ready') is True: break
            except (OSError,ValueError): pass
            require(time.monotonic()<deadline,'candidate_gateway_not_ready'); time.sleep(.1)
        transaction['candidate_ids'] = self.gateway_ids(candidate)
        transaction['ready'] = True
        self.event(self.task['state'])

    def restore_gateway(self):
        transaction = self.task['gateway']; old = transaction['old']
        require(self.gateway_ids(old) == transaction['old_ids'], 'gateway_container_identity_changed')
        records = json.loads(self.command('inspect',old['container']))
        if all(r.get('State',{}).get('Running') is False for r in records):
            self.command('start',old['container'])
        deadline = time.monotonic() + 30
        while True:
            try:
                status = self.api('gateway/status', base=old['admin_url'])
                break
            except (OSError, ValueError):
                require(time.monotonic() < deadline, 'rollback_gateway_not_ready'); time.sleep(.1)
        require(status.get('instance') == old['instance'], 'gateway_instance_changed')
        if status.get('drained') is True and status.get('active_requests') == 0:
            self.command('restart',old['container'])
            deadline=time.monotonic()+30
            while True:
                try:
                    status=self.api('gateway/status',base=old['admin_url'])
                    if status.get('ready') is True: break
                except OSError: pass
                require(time.monotonic()<deadline,'rollback_gateway_not_ready'); time.sleep(.1)
        require(status.get('instance')==old['instance'] and status.get('ready') is True,'rollback_gateway_not_ready')

    def finish_gateway(self, rollback):
        transaction = self.task['gateway']
        old = transaction['candidate' if rollback else 'old']; target = transaction['old' if rollback else 'candidate']
        expected = transaction['candidate_ids' if rollback else 'old_ids']
        require(self.gateway_ids(old)==expected,'gateway_container_identity_changed')
        deadline=time.monotonic()+self.config.get('drain_timeout_seconds',600)
        key='rollback' if rollback else 'forward'
        state='gateway_rollback_draining' if rollback else 'gateway_draining'
        records=json.loads(self.command('inspect',old['container']))
        already_stopped=transaction['drain_confirmed'].get(key) and all(r.get('State',{}).get('Running') is False for r in records)
        if not already_stopped:
            self.api('gateway/drain',{'instance':old['instance']},base=old['admin_url'])
            while True:
                proof=self.api('gateway/status',base=old['admin_url'])
                require(proof.get('instance')==old['instance'] and proof.get('schema')==1,'gateway_proof_mismatch')
                self.event(state,gateway_drain=proof)
                if proof.get('drained') is True and type(proof.get('active_requests')) is int and proof['active_requests']==0: break
                if time.monotonic()>=deadline:
                    self.event('gateway_rollback_waiting' if rollback else 'gateway_waiting'); return 2
                time.sleep(.2)
            transaction['drain_confirmed'][key]=True
            self.event(state)
            self.command('stop','--time','30',old['container'])
        save(Path(self.config['state_dir'])/'gateway-active.json',{'id':target['id'],'instance':target['instance'],'release_id':self.release['id']})
        return 0

    def switch_application(self, target):
        profile = self.profile(target)
        include = Path(self.config['upstream_include'])
        require(include.is_file() and not include.is_symlink(), 'dedicated_upstream_include_required')
        previous = include.read_bytes()
        require(re.fullmatch(rb'\s*upstream truerouter_app\s*\{\s*server 127\.0\.0\.1:[0-9]+;\s*\}\s*', previous), 'unexpected_upstream_configuration')
        require(isinstance(profile['port'], int) and 0 < profile['port'] < 65536, 'invalid_application_port')
        value = f'upstream truerouter_app {{ server 127.0.0.1:{profile["port"]}; }}\n'.encode()
        temporary = include.with_suffix('.rollout-pending')
        with os.fdopen(os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), 'wb') as file:
            file.write(value); file.flush(); os.fsync(file.fileno())
        require(include.read_bytes() == previous, 'upstream_configuration_changed')
        os.replace(temporary, include)
        proxy, binary = self.config['proxy_container'], self.config.get('proxy_binary', 'nginx')
        try:
            self.command('exec', proxy, binary, '-t')
            self.command('exec', proxy, binary, '-s', 'reload')
        except Exception:
            temporary.write_bytes(previous); os.replace(temporary, include)
            self.command('exec', proxy, binary, '-t')
            self.command('exec', proxy, binary, '-s', 'reload')
            raise
        save(Path(self.config['state_dir']) / 'application-active.json', {'id': target, 'image': self.release['image'] if target == self.task['candidate'] else self.task.get('old_image'), 'release_id': self.release['id']})

    def application_ready(self, profile):
        status = self.api('status', base=profile['url'])
        require(type(status.get('schema')) is int and status['schema'] == 1 and status.get('instance') == profile['instance'] and status.get('accepting') is True and type(status.get('pending_usage_records')) is int and status['pending_usage_records'] >= 0, 'application_not_ready')
        with urllib.request.build_opener(NoRedirect).open(profile['url'] + '/health', timeout=8) as response:
            require(response.status == 200, 'application_health_failed')

    def apply_application(self):
        candidate = self.profile(self.release['candidate'])
        if not self.task:
            active = Path(self.config['state_dir']) / 'application-active.json'
            old = json.loads(active.read_text())['id'] if active.exists() else self.config['application_active']
            require(old != candidate['id'], 'existing_application_required')
            self.task = {'release': self.release, 'config_digest': digest(self.config), 'old': old, 'candidate': candidate['id'], 'old_containers': self.identities(self.profile(old)), 'state': 'prepared'}
            self.event('prepared')
        if self.task['state'] in ['completed', 'rolled_back']:
            return 0
        if self.task['state'] == 'prepared':
            self.command('pull', self.release['image'])
            image = json.loads(self.command('image', 'inspect', self.release['image']))[0]
            require(image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == self.release['commit'], 'image_source_mismatch')
            self.start(candidate)
            self.application_ready(candidate)
            self.event('candidate_ready', candidate_containers=self.identities(candidate))
        if self.task['state'] == 'candidate_ready':
            self.switch_application(candidate['id'])
            self.event('application_draining')
        return self.finish_application(self.task['old'], 'completed')

    def finish_application(self, old, terminal):
        profile = self.profile(old)
        proof = self.api('drain', {}, base=profile['url'])
        deadline = time.monotonic() + self.config.get('drain_timeout_seconds', 600)
        while True:
            if terminal == 'completed':
                try:
                    self.application_ready(self.profile(self.task['candidate']))
                except Exception:
                    return self.rollback_application()
            require(type(proof.get('schema')) is int and proof['schema'] == 1 and proof.get('instance') == profile['instance'] and type(proof.get('active_requests')) is int and type(proof.get('pending_usage_records')) is int, 'application_proof_mismatch')
            self.event('application_draining' if terminal == 'completed' else 'application_rollback_draining', last_drain=proof)
            if proof.get('drained') is True and proof.get('active_requests') == 0 and proof.get('pending_usage_records') == 0:
                break
            if time.monotonic() >= deadline:
                self.event('application_waiting' if terminal == 'completed' else 'application_rollback_waiting')
                return 2
            time.sleep(.2)
            proof = self.api('status', base=profile['url'])
        expected = self.task['old_containers'] if old == self.task['old'] else self.task['candidate_containers']
        require(self.identities(profile) == expected, 'container_identity_changed')
        self.command('stop', '--time', '30', *profile['resources']['containers'])
        self.event(terminal)
        return 0

    def rollback_application(self):
        require(self.task is not None, 'task_not_found')
        if self.task['state'] == 'rolled_back':
            return 0
        if self.task['state'] not in ['application_rollback_draining', 'application_rollback_waiting']:
            profile = self.profile(self.task['old'])
            require(self.identities(profile) == self.task['old_containers'], 'rollback_container_identity_changed')
            self.command('start', *profile['resources']['containers'])
            self.api('resume', {}, base=profile['url'])
            self.application_ready(profile)
            self.switch_application(profile['id'])
            self.event('application_rollback_draining')
        return self.finish_application(self.task['candidate'], 'rolled_back')


@contextlib.contextmanager
def production_lock(config):
    path = Path(config['lock_file'])
    require(path.is_absolute(), 'absolute_lock_required')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), 'r+') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('production_release_busy') from None
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['apply', 'rollback', 'status'])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--release', type=Path, required=True)
    args = parser.parse_args()
    publisher = Publisher(args.config, args.release)
    if args.command == 'status':
        print(json.dumps(publisher.task or {'state': 'not_started'}))
        return 0
    with production_lock(publisher.config):
        # 锁内重新读取事务，避免并行任务在等待前缓存过时状态。
        publisher = Publisher(args.config, args.release)
        code = publisher.apply() if args.command == 'apply' else publisher.rollback()
        print(json.dumps({'state': publisher.task['state'], 'release_id': publisher.release['id']}))
        return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'code': str(error) if isinstance(error, ValueError) else 'release_operation_failed'}))
        raise SystemExit(1)
