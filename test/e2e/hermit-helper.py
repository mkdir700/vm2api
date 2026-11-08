#!/usr/bin/env python3
"""在禁止外网的 Linux 网络命名空间中验收 Hermit helper 拒绝契约。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('out', 'node', 'api-kernel'):
        parser.add_argument('--'+name, required=True, type=Path)
    parser.add_argument('--inside', action='store_true')
    args = parser.parse_args()
    out = args.out.resolve()
    repo = Path(__file__).resolve().parents[2]
    if args.inside:
        subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True)
        namespace = os.readlink('/proc/self/ns/net')
        assert namespace != os.readlink('/proc/1/ns/net')
        assert {row['ifname'] for row in json.loads(subprocess.check_output(['/usr/sbin/ip', '-json', 'link', 'show']))} == {'lo'}
        denied = []
        for family, address in [(socket.AF_INET, ('192.0.2.1', 443)), (socket.AF_INET6, ('2001:db8::1', 443))]:
            with socket.socket(family) as stream:
                stream.settimeout(1)
                code = stream.connect_ex(address)
            assert code in (1, 13, 101, 113)
            denied.append({'family': family, 'denied': True, 'errno': code})
        (out/'isolation.json').write_text(json.dumps({'namespace': namespace, 'remote_egress': denied})+'\n')
        env = {'PATH': str(args.node.parent)+':/usr/bin:/bin', 'HOME': str(out), 'NODE_NO_WARNINGS': '1',
            'KIN_API_KERNEL_BIN': str(args.api_kernel.resolve()), 'HERMIT_E2E_OUT': str(out)}
        result = subprocess.run([str(args.node.resolve()), '--test', str(repo/'test/e2e/hermit-helper.e2e.test.mjs')],
            env=env, capture_output=True, text=True, timeout=75)
        (out/'node-test.json').write_text(json.dumps({'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, indent=2)+'\n')
        def remaining():
            found = {}
            for item in Path('/proc').iterdir():
                if not item.name.isdigit() or int(item.name) == os.getpid():
                    continue
                try:
                    if os.readlink(item/'ns/net') == namespace:
                        found[item.name] = (item/'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
                except OSError:
                    pass
            return found
        until = time.monotonic()+3
        while remaining() and time.monotonic() < until:
            time.sleep(.05)
        leaked = remaining()
        (out/'processes-after-run.json').write_text(json.dumps(leaked, indent=2)+'\n')
        for pid in leaked:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
        return result.returncode or int(bool(leaked))
    if sys.platform != 'linux':
        parser.error('需要 Linux 网络命名空间权限')
    out.mkdir(parents=True, exist_ok=False)
    sources = sorted({*repo.glob('src/**/*.mjs'), *repo.glob('api-kernel/**/*.go'), repo/'api-kernel/go.mod',
        repo/'api-kernel/go.sum', repo/'test/harness.mjs', Path(__file__).resolve(), repo/'test/e2e/hermit-helper.e2e.test.mjs'})
    pins = {str(file.relative_to(repo)): sha(file) for file in sources}
    command = ['/usr/bin/unshare', '--net', sys.executable, str(Path(__file__).resolve()), '--inside',
        '--out', str(out), '--node', str(args.node.resolve()), '--api-kernel', str(args.api_kernel.resolve())]
    result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    same = all(sha(repo/name) == digest for name, digest in pins.items())
    for name in pins:
        target = out/'sources'/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repo/name, target)
    native = json.loads((out/'summary.json').read_text()) if (out/'summary.json').exists() else {'result': 'FAIL'}
    receipt = {'result': 'PASS' if result.returncode == 0 and same and native['result'] == 'PASS' else 'FAIL',
        'native': native, 'source_unchanged': same, 'sources': pins,
        'binaries': {'node': sha(args.node), 'api_kernel': sha(args.api_kernel)},
        'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    (out/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps({key: value for key, value in receipt.items() if key not in ('sources', 'stdout', 'stderr')}))
    return 0 if receipt['result'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
