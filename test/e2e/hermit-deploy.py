#!/usr/bin/env python3
"""Build the integrated image and verify its real entrypoint in an isolated container."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid


def run(argv, **kwargs):
    return subprocess.run(argv, text=True, capture_output=True, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hermit', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(mode=0o700)
    source = Path(__file__).resolve().parents[2]
    command = [sys.executable, str(source / 'deploy/hermit.py'), '--hermit-source', str(Path(args.hermit).resolve()),
               '--directory', str(out / 'deployment'), '--build-only']
    checks = []

    def record(name, passed):
        checks.append({'check': name, 'result': 'PASS' if passed else 'FAIL'})
        (out / 'summary.json').write_text(json.dumps({'checks': checks, 'real_upstream_requests': 0}, indent=2) + '\n')
        print(json.dumps(checks[-1]), flush=True)

    with (out / 'build.log').open('w') as log:
        process = subprocess.run(command, text=True, stdout=log, stderr=subprocess.STDOUT)
    built = subprocess.CompletedProcess(command, process.returncode, (out / 'build.log').read_text(), '')
    if process.returncode != 0:
        record('integrated_image_built', False)
        raise SystemExit(process.returncode)
    state = json.loads((out / 'deployment/deployment.json').read_text())
    record('integrated_image_built', state['status'] == 'built' and state['image_id'].startswith('sha256:'))
    env_file = out / 'deployment/.env'
    before = env_file.read_bytes()
    values = dict(line.split('=', 1) for line in before.decode().splitlines() if line and not line.startswith('#'))
    record('private_random_credentials', env_file.stat().st_mode & 0o777 == 0o600
           and len(values['VM2API_ADMIN_PASSWORD']) >= 32 and values['VM2API_ADMIN_PASSWORD'] != '123456')
    record('credentials_not_printed', all(value not in built.stdout + built.stderr for key, value in values.items()
                                        if key in ['VM2API_API_KEY', 'VM2API_ADMIN_PASSWORD', 'VM2API_DB_SECRET']))
    rerun = run(command)
    (out / 'rerun.log').write_text(rerun.stdout + rerun.stderr)
    state = json.loads((out / 'deployment/deployment.json').read_text())
    after = dict(line.split('=', 1) for line in env_file.read_text().splitlines() if line and not line.startswith('#'))
    record('rerun_preserves_private_configuration', all(after.get(key) == value for key, value in values.items() if key != 'VM2API_DEPLOY_IMAGE'))
    run(['docker', 'compose', '--project-directory', str(out / 'deployment'), '--env-file', str(env_file),
         '-f', str(out / 'deployment/compose.yaml'), 'config', '--quiet'])
    record('compose_configuration_valid', True)
    current_env = env_file.read_bytes()
    try:
        env_file.write_text('\n'.join('VM2API_API_KEY=' if line.startswith('VM2API_API_KEY=') else line for line in current_env.decode().splitlines()) + '\n')
        rejected = subprocess.run(command, text=True, capture_output=True)
        record('missing_credentials_rejected_without_reset', rejected.returncode != 0 and 'VM2API_API_KEY=\n' in env_file.read_text())
    finally:
        env_file.write_bytes(current_env)
    config = json.loads(run(['docker', 'compose', '--project-directory', str(out / 'deployment'), '--env-file', str(env_file),
                             '-f', str(out / 'deployment/compose.yaml'), 'config', '--format', 'json']).stdout)
    record('manual_compose_uses_managed_project', config['name'] == state['project'])
    run(['docker', 'compose', '--dry-run', '--project-directory', str(out / 'deployment'), '--env-file', str(env_file),
         '-f', str(out / 'deployment/compose.yaml'), 'up', '-d', '--no-build', '--pull', 'never'])
    record('compose_start_plan_valid', True)


    name = 'hermit-deploy-e2e-' + uuid.uuid4().hex[:12]
    try:
        run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--env-file', str(env_file), state['image']])
        ready = False
        for _ in range(90):
            result = subprocess.run(['docker', 'exec', name, 'node', '-e',
                                     "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)"],
                                    capture_output=True)
            if result.returncode == 0:
                ready = True
                break
            time.sleep(1)
        record('real_control_plane_starts', ready)
        probe = r'''
const fs=require('node:fs'),crypto=require('node:crypto');
const m=JSON.parse(fs.readFileSync('/opt/vm2api/hermit-payload.json'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hashes=Object.entries(m.files).every(([p,h])=>hash('/opt/vm2api/'+p)===h);
const headers={'x-api-key':process.env.VM2API_API_KEY,'content-type':'application/json'};
(async()=>{
 const page=await fetch('http://127.0.0.1:8787/console/');
 const update=await fetch('http://127.0.0.1:8787/api/panel/update',{method:'POST',headers,body:JSON.stringify({confirm:true})});
 const body=await update.json();
 console.log(JSON.stringify({hashes,console:page.ok,shim:fs.existsSync('/opt/vm2api/share/wrap-cli/glibc239'),
 runtime:process.env.VM2API_SLOT_RUNTIME,update_status:update.status,update_blocked:JSON.stringify(body).includes('managed_hermit_deployment')}));
})().catch(()=>process.exitCode=1);
'''
        result = json.loads(run(['docker', 'exec', name, 'node', '-e', probe]).stdout)
        record('entrypoint_installs_hermit_and_official_cli', result['hashes'] and result['runtime'] == 'hermit')
        record('legacy_glibc_shim_absent', not result['shim'])
        record('console_assets_present', result['console'])
        record('upstream_update_cannot_replace_hermit', result['update_status'] == 409 and result['update_blocked'])
        run(['docker', 'exec', name, '/opt/vm2api/bin/kin-kernel', '--help'])
        record('installed_kernel_alias_executes', True)
        run(['docker', 'restart', name])
        restarted = False
        for _ in range(45):
            result = subprocess.run(['docker', 'exec', name, 'node', '-e',
                                     "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)"], capture_output=True)
            if result.returncode == 0:
                restarted = True
                break
            time.sleep(1)
        record('container_restart_succeeds', restarted)
    finally:
        subprocess.run(['docker', 'logs', name], stdout=(out / 'container.log').open('w'), stderr=subprocess.STDOUT)
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
    record('owned_container_removed', subprocess.run(['docker', 'inspect', name], capture_output=True).returncode != 0)
    summary = {'checks': checks, 'image': state['image'], 'image_id': state['image_id'], 'source': state['sources'],
               'probe_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'real_upstream_requests': 0, 'production_changed': False,
               'not_run': ['KVM guest', '9p persistence', 'real account', 'proxy egress']}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if any(row['result'] != 'PASS' for row in checks):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
