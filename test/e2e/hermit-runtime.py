#!/usr/bin/env python3
"""在 Linux 网络命名空间内验证控制平面安装、选择和真实 CLI 工具循环。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('out', 'node', 'archive', 'receipt', 'cli-source', 'api-kernel'):
        parser.add_argument('--'+name, required=True, type=Path)
    parser.add_argument('--inside', action='store_true')
    parser.add_argument('--docker-image', help='本地固定 sha256 镜像；不自动拉取')
    parser.add_argument('--docker-failure', choices=['missing-tmux', 'no-init', 'container-exit'])
    parser.add_argument('--docker-container', help=argparse.SUPPRESS)
    parser.add_argument('--fixture-root', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    out = args.out.resolve()
    if sys.platform != 'linux':
        parser.error('需要 Linux')
    if args.inside:
        namespace = os.readlink('/proc/self/ns/net')
        assert namespace != os.readlink('/proc/1/ns/net')
        subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True)
        assert {row['ifname'] for row in json.loads(subprocess.check_output(['/usr/sbin/ip', '-json', 'link', 'show']))} == {'lo'}
        results = []
        for family, address in [(socket.AF_INET, ('192.0.2.1', 443)), (socket.AF_INET6, ('2001:db8::1', 443))]:
            with socket.socket(family) as stream:
                stream.settimeout(1); code = stream.connect_ex(address)
            assert code in (1, 13, 101, 113)
            results.append({'family': family, 'denied': True})
        (out/'isolation.json').write_text(json.dumps({'namespace': namespace, 'remote_egress': results})+'\n')
        command = [str(args.node), str(Path(__file__).with_suffix('.mjs')), str(out), str(args.archive.resolve()),
            str(args.receipt.resolve()), str(args.cli_source.resolve()), str(args.api_kernel.resolve())]
        environment = {'PATH': str(args.node.parent)+':/usr/bin:/bin', 'HOME': str(out), 'NODE_NO_WARNINGS': '1'}
        if args.docker_container:
            environment.update(HERMIT_E2E_DOCKER_CONTAINER=args.docker_container,
                HERMIT_E2E_FIXTURE_ROOT=str(args.fixture_root),
                HERMIT_E2E_DOCKER_FAILURE=args.docker_failure or '')
        result = subprocess.run(command, env=environment)
        return result.returncode
    out.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    sources = [*root.glob('src/**/*.mjs'), *root.glob('scripts/*.py'), *root.glob('test/e2e/hermit-*'), root/'test/fixtures/hermit-mcp.py', root/'test/fixtures/hermit-docker.Dockerfile', root/'docker/kin-os/ubuntu-24.04/Dockerfile']
    before = {str(p.relative_to(root)): sha(p) for p in sources}
    command = ['/usr/bin/unshare', '--net', sys.executable, str(Path(__file__).resolve()), '--inside',
        '--out', str(out), '--node', str(args.node.resolve()), '--archive', str(args.archive.resolve()),
        '--receipt', str(args.receipt.resolve()), '--cli-source', str(args.cli_source.resolve()), '--api-kernel', str(args.api_kernel.resolve())]
    container = None
    container_pid = None
    fixture = None
    try:
        if args.docker_image:
            if not args.docker_image.startswith('sha256:') or len(args.docker_image) != 71:
                parser.error('使用完整的本地镜像 sha256')
            image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', args.docker_image]))[0]
            assert image['Id'] == args.docker_image and image['Architecture'] == 'amd64'
            fixture = Path(tempfile.mkdtemp(prefix='hmd-', dir='/tmp'))
            fixture.chmod(0o755)
            pool = fixture/'p/share/kernel-packages'; pool.mkdir(parents=True)
            run = fixture/'p/vms/vm-hermit/run'; run.mkdir(parents=True)
            run.chmod(0o700); os.chown(run, 10001, 987)
            container = 'hermit-e2e-'+fixture.name
            subprocess.run(['docker', 'create', '--pull=never', '--name', container,
                '--label', 'hermit.e2e='+fixture.name, '--network', 'none', *([] if args.docker_failure == 'no-init' else ['--init']), '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:987',
                '--pids-limit', '256', '-e', 'HOME=/home/kincli', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
                '--tmpfs', '/home/kincli:rw,uid=10001,gid=987,mode=700',
                '--mount', 'type=bind,src='+str(pool)+',dst=/opt/kin-kernel-packages,readonly',
                '--mount', 'type=bind,src='+str(run)+',dst=/run/kin',
                args.docker_image, 'sleep', 'infinity'], check=True, capture_output=True)
            subprocess.run(['docker', 'start', container], check=True, capture_output=True)
            info = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
            assert info['HostConfig']['NetworkMode'] == 'none'
            container_pid = info['State']['Pid']
            (out/'container.json').write_text(json.dumps({k: info[k] for k in ['Id', 'Image', 'Mounts', 'State', 'HostConfig']}, indent=2)+'\n')
            command[:2] = ['/usr/bin/nsenter', '--target', str(container_pid), '--net']
            command += ['--docker-container', container, '--fixture-root', str(fixture)]
            if args.docker_failure: command += ['--docker-failure', args.docker_failure]
        result = subprocess.run(command, capture_output=True, text=True, timeout=220)
        status = result.returncode
        (out/'driver.json').write_text(json.dumps({'command': command, 'exit_code': status, 'stdout': result.stdout, 'stderr': result.stderr}, indent=2)+'\n')
    except subprocess.TimeoutExpired:
        status = 124
    except Exception as error:
        status = 1
        (out/'driver-error.json').write_text(json.dumps({'error': str(error)})+'\n')
    tag = out/'isolation.json'; namespace = json.loads(tag.read_text())['namespace'] if tag.exists() else None
    def remaining():
        result = []
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit(): continue
            try:
                if namespace and os.readlink(proc/'ns/net') == namespace: result.append(int(proc.name))
            except OSError: pass
        return result
    holders = {container_pid} if container_pid else set()
    inventory = []
    for pid in remaining():
        try:
            proc = Path('/proc')/str(pid)
            command_line = (proc/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            parent = next(line.split()[1] for line in (proc/'status').read_text().splitlines() if line.startswith('PPid:'))
            inventory.append({'pid': pid, 'parent': int(parent), 'argv': [arg.decode(errors='replace') for arg in command_line]})
            if int(parent) == container_pid and command_line == [b'sleep', b'infinity']: holders.add(pid)
        except OSError: pass
    (out/'processes-after-run.json').write_text(json.dumps(inventory, indent=2)+'\n')
    leaked = [pid for pid in remaining() if pid not in holders]
    for pid in leaked:
        try:
            if os.readlink('/proc/'+str(pid)+'/ns/net') == namespace: os.kill(pid, signal.SIGKILL)
        except OSError: pass
    if container:
        result = subprocess.run(['docker', 'inspect', container], capture_output=True, text=True)
        if result.returncode == 0:
            inspect = json.loads(result.stdout)[0]
            assert inspect['Config']['Labels'].get('hermit.e2e') == fixture.name
            subprocess.run(['docker', 'rm', '-f', container], check=True, capture_output=True)
        if fixture.exists():
            for owner in fixture.glob('p/vms/vm-hermit/run/h-*/owner.json'):
                (out/('cleanup-'+owner.parent.name+'.json')).write_bytes(owner.read_bytes())
            shutil.rmtree(fixture)
    deadline = time.monotonic()+3
    while remaining() and time.monotonic()<deadline: time.sleep(.05)
    unchanged = before == {str(p.relative_to(root)): sha(p) for p in sources}
    summary = json.loads((out/'summary.json').read_text()) if (out/'summary.json').exists() else {'result': 'FAIL'}
    success = status == 0 and not leaked and not remaining() and unchanged and summary['result'] == 'PASS'
    for source in sources:
        target = out/'sources'/source.relative_to(root); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(source.read_bytes())
    (out/'receipt.json').write_text(json.dumps({'result': 'PASS' if success else 'FAIL', 'exit_code': status,
        'sources': before, 'source_unchanged': unchanged, 'leaked_namespace_pids': leaked, 'namespace_gone': not remaining(),
        'physical_docker': bool(container), 'holder_pids': sorted(holders), 'fixture_removed': fixture is not None and not fixture.exists(), 'container_removed': bool(container) and subprocess.run(['docker', 'inspect', container], capture_output=True).returncode != 0,
        'archive_sha256': sha(args.archive), 'cli_sha256': sha(args.cli_source), 'api_kernel_sha256': sha(args.api_kernel)}, indent=2)+'\n')
    print(json.dumps({'result': 'PASS' if success else 'FAIL', 'native': summary, 'leaked_namespace_pids': leaked}))
    return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(main())
