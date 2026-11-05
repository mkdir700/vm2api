#!/usr/bin/env python3
"""Build and start the integrated vm2api/Hermit deployment with one command."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import subprocess
import sys
import time
import urllib.request


def run(argv, *, capture=False, env=None):
    if not capture:
        print('+ ' + ' '.join(map(str, argv)), flush=True)
    result = subprocess.run(list(map(str, argv)), check=True, text=True, capture_output=capture, env=env)
    return result.stdout.strip() if capture else ''


def atomic(path, value):
    temp = path.with_name(path.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    path.chmod(0o600)


def source_hash(root, names):
    hashes = {}
    for name in names:
        source = root / name
        paths = sorted(source.rglob('*')) if source.is_dir() else [source]
        for path in paths:
            relative = path.relative_to(root)
            if any(part in ['node_modules', '.git', '__pycache__', 'dist'] for part in relative.parts):
                continue
            if path.is_symlink():
                raise SystemExit('构建源码中不允许符号链接：' + str(relative))
            if not path.is_file() or path.name.startswith(('.env', '._')) or path.suffix in ['.key', '.sqlite', '.enc', '.dek']:
                continue
            hashes[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()
    if not hashes:
        raise SystemExit('构建源码为空：' + str(root))
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def update_env(path, changes):
    lines = path.read_text().splitlines() if path.exists() else []
    seen, output = set(), []
    for line in lines:
        match = re.match(r'^([A-Z][A-Z0-9_]*)=', line)
        if not match:
            output.append(line)
            continue
        key = match.group(1)
        if key in seen:
            raise SystemExit('环境文件存在重复字段：' + key)
        seen.add(key)
        output.append(key + '=' + changes[key] if key in changes else line)
    output.extend(key + '=' + value for key, value in changes.items() if key not in seen)
    atomic(path, '\n'.join(output) + '\n')


def compose(root, project, *args):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('VM2API_', 'KIN_', 'COMPOSE_')) and key not in ['PORT', 'HOST']}
    return run(['docker', 'compose', '--project-directory', root, '--project-name', project,
                '--env-file', root / '.env', '-f', root / 'compose.yaml', *args], env=env)


def main():
    source = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description='一条命令构建并启动包含 Hermit 的 vm2api。')
    parser.add_argument('--hermit-source', default=str(source.parent / 'hermit'))
    parser.add_argument('--directory', default=str(source.parent / '.deploy/vm2api-hermit'))
    parser.add_argument('--port', type=int)
    parser.add_argument('--build-only', action='store_true', help='只构建并生成部署文件，不启动服务')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() not in ['x86_64', 'amd64']:
        raise SystemExit('请在 Linux amd64 Docker 宿主机运行此命令。')
    hermit = Path(args.hermit_source).resolve()
    if not (hermit / 'deploy/vm2api.Dockerfile').is_file():
        raise SystemExit('缺少 Hermit 源码。请将两个仓库放在同一目录，或指定 --hermit-source。')
    run(['docker', 'version', '--format', '{{.Server.Version}}'], capture=True)
    run(['docker', 'compose', 'version', '--short'], capture=True)
    endpoint = os.environ.get('DOCKER_HOST') or run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], capture=True)
    if not endpoint.startswith('unix://'):
        raise SystemExit('请在 Docker 宿主机本地运行，不能使用远程 Docker context。')
    root = Path(args.directory).absolute()
    if root.is_symlink():
        raise SystemExit('部署目录不能是符号链接。')
    root = root.resolve()
    project = 'vm2api-hermit-' + hashlib.sha256(str(root).encode()).hexdigest()[:10]
    if not args.build_only:
        controls = run(['docker', 'ps', '--filter', 'label=com.docker.compose.service=vm2api', '--format', '{{.Names}}'], capture=True).splitlines()
        if any(name != project for name in controls):
            raise SystemExit('宿主机已有其他 vm2api 控制面。当前命令不会自动迁移现有槽位。')
    marker = root / '.hermit-installation.json'
    if root.exists() and any(root.iterdir()) and not marker.is_file():
        raise SystemExit('部署目录不为空，且不属于本安装命令。请指定新目录。')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_uid != os.geteuid():
        raise SystemExit('部署目录不属于当前用户。')
    lockfd = os.open(root / '.deploy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('另一个部署命令正在运行。')
        if marker.exists():
            if json.loads(marker.read_text()) != {'kind': 'vm2api-hermit', 'project': project}:
                raise SystemExit('部署目录标记不匹配。')
        else:
            atomic(marker, json.dumps({'kind': 'vm2api-hermit', 'project': project}) + '\n')
        env_file = root / '.env'
        if not env_file.exists() and (root / 'deployment.json').exists():
            raise SystemExit('私有配置文件丢失。命令不会生成替代凭据。')
        if not env_file.exists():
            update_env(env_file, {'VM2API_ADMIN_USER': 'admin', 'VM2API_ADMIN_PASSWORD': secrets.token_hex(32),
                                 'VM2API_API_KEY': secrets.token_hex(32), 'VM2API_DB_SECRET': secrets.token_hex(32),
                                 'VM2API_CONTAINER_NAME': project, 'COMPOSE_PROJECT_NAME': project, 'VM2API_DEPLOYMENT_ID': project, 'PORT': str(args.port or 8787), 'KIN_AUTO_SYNC_WRAP': '1'})
        settings = dict(line.split('=', 1) for line in env_file.read_text().splitlines() if re.match(r'^[A-Z][A-Z0-9_]*=', line))
        for key in ['VM2API_ADMIN_USER', 'VM2API_ADMIN_PASSWORD', 'VM2API_API_KEY', 'VM2API_DB_SECRET']:
            if not settings.get(key, '').strip().strip("\"'"):
                raise SystemExit('私有配置字段缺失，命令不会自动重置：' + key)
        if settings.get('VM2API_CONTAINER_NAME') != project:
            raise SystemExit('私有配置中的控制面名称与部署目录不匹配。')
        if args.port is not None:
            if not 1 <= args.port <= 65535:
                raise SystemExit('端口应在 1 到 65535 之间。')
            update_env(env_file, {'PORT': str(args.port)})
        vm_hash = source_hash(source, ['Dockerfile', 'Dockerfile.hermit', '.dockerignore', 'package.json', 'package-lock.json', 'VERSION', 'CHANGELOG.md',
                                      'src', 'scripts', 'api-kernel', 'web', 'docker', 'deploy/payload.json', 'share/wrap-cli/kin-kernel', 'share/wrap-cli/SAMPLE.json'])
        hermit_hash = source_hash(hermit, ['go.mod', 'go.sum', '.dockerignore', 'cmd', 'internal', 'deploy/vm2api.Dockerfile',
                                         'deploy/vm2api_fetch.py', 'deploy/vm2api_payload.py', 'deploy/node/versions.json'])
        combined = hashlib.sha256((vm_hash + hermit_hash).encode()).hexdigest()[:20]
        base, payload = 'clearcc/vm2api-base:' + vm_hash[:20], 'clearcc/hermit-payload:' + hermit_hash[:20]
        image = 'clearcc/vm2api-hermit:' + combined
        run(['docker', 'build', '--platform', 'linux/amd64', '-t', base, '-f', source / 'Dockerfile', source])
        run(['docker', 'build', '--platform', 'linux/amd64', '-t', payload, '-f', hermit / 'deploy/vm2api.Dockerfile', hermit])
        run(['docker', 'build', '--platform', 'linux/amd64', '-t', image, '-f', source / 'Dockerfile.hermit',
             '--build-arg', 'VM2API_BASE_IMAGE=' + base, '--build-arg', 'HERMIT_PAYLOAD_IMAGE=' + payload, source])
        image_id = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], capture=True)
        update_env(env_file, {'VM2API_DEPLOY_IMAGE': image_id, 'VM2API_DEPLOYMENT_ID': project, 'COMPOSE_PROJECT_NAME': project})
        template = (source / 'docker-compose.yml').read_text()
        template = re.sub(r'^    image:.*$', '    image: ${VM2API_DEPLOY_IMAGE:?Run the Hermit deployment command}\n    pull_policy: never', template, count=1, flags=re.MULTILINE)
        atomic(root / 'compose.yaml', template)
        for name in ['vms', 'data', 'bin', 'share', 'src/config']:
            (root / name).mkdir(parents=True, exist_ok=True)
        compose(root, project, 'config', '--quiet')
        receipt = {'kind': 'vm2api-hermit', 'status': 'built', 'image': image_id, 'image_id': image_id,
                   'image_tag': image, 'project': project, 'sources': {'vm2api': vm_hash, 'hermit': hermit_hash},
                   'installer_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        atomic(root / 'deployment.json', json.dumps(receipt, indent=2) + '\n')
        if not args.build_only:
            compose(root, project, 'up', '-d', '--no-build', '--pull', 'never')
            port = next(line.split('=', 1)[1] for line in env_file.read_text().splitlines() if line.startswith('PORT='))
            ready = False
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for _ in range(60):
                try:
                    with opener.open('http://127.0.0.1:' + port + '/health', timeout=2) as response:
                        if json.load(response).get('deployment_id') == project:
                            ready = True
                            break
                except (OSError, ValueError):
                    time.sleep(1)
            if not ready:
                raise SystemExit('控制面没有通过健康检查。请查看该目录的 Compose 日志。')
            receipt['status'] = 'running'
            atomic(root / 'deployment.json', json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'directory': str(root), 'status': receipt['status'], 'image_id': image_id,
                          'credentials_file': str(env_file)}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit('部署命令失败，退出码：' + str(error.returncode))
