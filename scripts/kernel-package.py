#!/usr/bin/env python3
"""校验并安装独立内核包。安装不激活槽位。"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_PAYLOAD = 128 * 1024 * 1024
HOOKS = ('probe-native-input.mjs', 'probe-input-screening.mjs', 'probe-dispatch-gate.mjs', 'response-relay.mjs')
FILES = {'bin/hermit': 0o755, **{'hooks/'+name: 0o644 for name in HOOKS}}


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def valid_name(value):
    return isinstance(value, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9.+-]{0,79}', value) is not None


def load_manifest(raw):
    require(len(raw) <= 65536, 'manifest_too_large')
    m = json.loads(raw, object_pairs_hook=pairs)
    require(m['schema_version'] == 2 and m['runtime'] == 'hermit', 'unsupported_package_format')
    require(valid_name(m['version']), 'invalid_version')
    require(m['target'] in ('linux-amd64', 'darwin-arm64'), 'unsupported_target')
    require(m['slot_protocol'] == 'vm2api-slot-1', 'unsupported_slot_protocol')
    require(m['entrypoints']['kernel'] == {'path': 'bin/hermit', 'args': ['--mode', 'vm2api-slot']}, 'invalid_kernel_entrypoint')
    require(set(m['files']) == set(FILES), 'invalid_payload_files')
    total = 0
    for name, mode in FILES.items():
        item = m['files'][name]
        require(type(item['bytes']) is int and 0 < item['bytes'] <= MAX_PAYLOAD and item['mode'] == mode and valid_sha(item['sha256']), 'invalid_payload_metadata')
        total += item['bytes']
    require(total <= MAX_PAYLOAD, 'payload_too_large')
    cli = m['cli']
    require(cli['provisioning'] == 'shared-cache' and valid_sha(cli['sha256']), 'invalid_cli_dependency')
    require(type(cli['bytes']) is int and 0 < cli['bytes'] <= 512*1024*1024, 'invalid_cli_size')
    require(re.fullmatch(r'\d+\.\d+\.\d+', cli['version']), 'invalid_cli_version')
    require(cli['platform'] == ('linux-x64' if m['target'] == 'linux-amd64' else 'darwin-arm64'), 'cli_target_mismatch')
    require(type(m['capabilities']['production']) is bool and type(m['capabilities']['helper_integration']) is bool, 'invalid_capabilities')
    if 'switch_readiness' in m['capabilities']:
        require(type(m['capabilities']['switch_readiness']) is bool, 'invalid_capabilities')
    if 'https_upstream' in m['capabilities']:
        require(type(m['capabilities']['https_upstream']) is bool, 'invalid_capabilities')
    if m['capabilities']['helper_integration']:
        require(m['entrypoints'].get('helper') == {'transport': 'internal-http', 'path': '/internal/v1/helper', 'protocol': 'hermit-helper-1'}, 'invalid_native_helper_entrypoint')
    require(m['acceptance'] in ('local-mock-only', 'production'), 'invalid_acceptance')
    return m


class PayloadInfo(tarfile.TarInfo):
    @classmethod
    def frombuf(cls, buf, encoding, errors):
        item = super().frombuf(buf, encoding, errors)
        require(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and item.name in {'manifest.json', *FILES}, 'unsafe_tar_member')
        require(0 <= item.size <= MAX_PAYLOAD, 'tar_member_too_large')
        return item


def executable(path, target):
    with path.open('rb') as stream:
        header = stream.read(32)
    require((header[:6] == b'\x7fELF\x02\x01' and len(header) >= 20 and struct.unpack('<H', header[18:20])[0] == 62)
        if target == 'linux-amd64' else header[:8] == b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01', 'executable_target_mismatch')


def unpack(args, stage):
    require(valid_sha(args.sha256) and valid_sha(args.manifest_sha256), 'invalid_expected_digest')
    require(0 < args.bytes <= MAX_ARCHIVE and args.archive.stat().st_size == args.bytes, 'archive_size_mismatch')
    require(digest(args.archive) == args.sha256, 'archive_hash_mismatch')
    with tarfile.open(args.archive, mode='r|gz', tarinfo=PayloadInfo) as archive:
        first = archive.next()
        require(first is not None and first.name == 'manifest.json' and first.size <= 65536 and first.mode == 0o644, 'invalid_manifest_member')
        raw = archive.extractfile(first).read()
        require(hashlib.sha256(raw).hexdigest() == args.manifest_sha256, 'manifest_hash_mismatch')
        m = load_manifest(raw)
        (stage/'manifest.json').write_bytes(raw)
        (stage/'manifest.json').chmod(0o644)
        seen = set()
        for member in archive:
            if member is first:
                continue
            require(member.name in FILES and member.name not in seen, 'duplicate_payload_member')
            seen.add(member.name); meta = m['files'][member.name]
            require(member.size == meta['bytes'] and member.mode == meta['mode'], 'payload_metadata_mismatch')
            target = stage/member.name; target.parent.mkdir(exist_ok=True)
            with target.open('xb') as output:
                shutil.copyfileobj(archive.extractfile(member), output, length=1024*1024)
            target.chmod(meta['mode'])
            require(digest(target) == meta['sha256'], 'payload_hash_mismatch')
        require(seen == set(FILES), 'missing_payload_member')
    executable(stage/'bin/hermit', m['target'])
    return m


def allowed_url(raw, cli, allow_loopback):
    url = urllib.parse.urlsplit(raw)
    require(not url.username and not url.password and not url.query and not url.fragment, 'cli_url_blocked')
    if allow_loopback and url.scheme == 'http' and url.hostname == '127.0.0.1':
        return
    require(url.scheme == 'https' and url.hostname == 'downloads.claude.ai' and url.port in (None, 443), 'cli_url_blocked')
    require(url.path == '/claude-code-releases/'+cli['version']+'/'+cli['platform']+'/claude', 'cli_url_blocked')


def ensure_cli(root, m, allow_loopback):
    cli = m['cli']; allowed_url(cli['download_url'], cli, allow_loopback)
    store = root/'cli'; store.mkdir(exist_ok=True)
    dest = store/cli['sha256']; binary = dest/'claude'
    if dest.exists() or dest.is_symlink():
        require(dest.is_dir() and not dest.is_symlink() and binary.is_file() and not binary.is_symlink(), 'cli_cache_invalid')
        require(binary.stat().st_size == cli['bytes'] and digest(binary) == cli['sha256'], 'cli_cache_corrupt')
        executable(binary, m['target'])
        return True
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            allowed_url(newurl, cli, allow_loopback)
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    opener = urllib.request.build_opener(Redirect())
    with tempfile.TemporaryDirectory(prefix='.cli-', dir=store) as temporary:
        stage = Path(temporary)/'ready'; stage.mkdir()
        binary = stage/'claude'; total = 0
        with opener.open(cli['download_url'], timeout=30) as response, binary.open('xb') as output:
            while chunk := response.read(1024*1024):
                total += len(chunk); require(total <= cli['bytes'], 'cli_download_too_large'); output.write(chunk)
        require(total == cli['bytes'] and digest(binary) == cli['sha256'], 'cli_download_hash_mismatch')
        executable(binary, m['target']); binary.chmod(0o555); stage.chmod(0o755)
        os.rename(stage, dest)
    return False


def inspect(root, runtime, target, version):
    require(runtime == 'hermit' and target in ('linux-amd64', 'darwin-arm64') and valid_name(version), 'invalid_package_id')
    version_dir = root/'versions'/runtime/target/version
    directory = version_dir/'payload'
    require(directory.is_dir() and not directory.is_symlink() and not version_dir.is_symlink(), 'package_not_installed')
    receipt_path = version_dir/'receipt.json'
    require(receipt_path.is_file() and not receipt_path.is_symlink() and receipt_path.stat().st_size <= 65536, 'invalid_install_receipt')
    manifest = directory/'manifest.json'; receipt = json.loads(receipt_path.read_text())
    require(manifest.is_file() and not manifest.is_symlink() and manifest.stat().st_size <= 65536 and digest(manifest) == receipt['manifest_sha256'], 'installed_manifest_mismatch')
    m = load_manifest(manifest.read_bytes())
    require((m['runtime'], m['target'], m['version']) == (runtime, target, version), 'installed_identity_mismatch')
    expected = {'manifest.json', *FILES}; found = set()
    for path in directory.rglob('*'):
        name = path.relative_to(directory).as_posix()
        require(not path.is_symlink(), 'installed_symlink')
        if path.is_dir():
            require(name in ('bin', 'hooks'), 'installed_extra_directory'); continue
        require(name in expected and path.is_file(), 'installed_extra_file'); found.add(name)
        if name in FILES:
            item = m['files'][name]
            require(path.stat().st_size == item['bytes'] and path.stat().st_mode & 0o7777 == item['mode'] and digest(path) == item['sha256'], 'installed_file_mismatch')
    require(found == expected, 'installed_missing_file')
    cli = root/'cli'/m['cli']['sha256']/'claude'
    require(cli.parent.is_dir() and not cli.parent.is_symlink() and cli.is_file() and not cli.is_symlink() and cli.stat().st_size == m['cli']['bytes'] and digest(cli) == m['cli']['sha256'], 'cli_cache_corrupt')
    return m, receipt


def install(args):
    root = args.root; root.mkdir(parents=True, exist_ok=True)
    with (root/'.install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='.package-', dir=root) as temporary:
            ready = Path(temporary)/'ready'; ready.mkdir()
            stage = ready/'payload'; stage.mkdir()
            m = unpack(args, stage)
            parent = root/'versions'/m['runtime']/m['target']; parent.mkdir(parents=True, exist_ok=True)
            dest = parent/m['version']
            if dest.exists() or dest.is_symlink():
                _, receipt = inspect(root, m['runtime'], m['target'], m['version'])
                require(receipt['manifest_sha256'] == args.manifest_sha256, 'package_version_conflict')
                return {**receipt, 'idempotent': True, 'cached_cli': True}
            cached = ensure_cli(root, m, args.allow_loopback)
            receipt = {'runtime': m['runtime'], 'version': m['version'], 'target': m['target'], 'manifest_sha256': args.manifest_sha256,
                'archive_sha256': args.sha256, 'cli_sha256': m['cli']['sha256'], 'activated': False}
            (ready/'receipt.json').write_text(json.dumps(receipt, sort_keys=True, indent=2)+'\n')
            for directory in [ready, stage, stage/'bin', stage/'hooks']:
                directory.chmod(0o755)
            os.rename(ready, dest)
            inspect(root, m['runtime'], m['target'], m['version'])
            return {**receipt, 'idempotent': False, 'cached_cli': cached}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('install')
    for name in ('archive', 'root'):
        create.add_argument('--'+name, type=Path, required=True)
    for name in ('sha256', 'manifest-sha256'):
        create.add_argument('--'+name, required=True)
    create.add_argument('--bytes', type=int, required=True)
    create.add_argument('--allow-loopback', action='store_true')
    check = commands.add_parser('inspect')
    check.add_argument('--root', type=Path, required=True)
    for name in ('runtime', 'target', 'version'):
        check.add_argument('--'+name, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'install':
            result = install(args)
        else:
            m, receipt = inspect(args.root, args.runtime, args.target, args.version)
            result = {**receipt, 'manifest': m}
        print(json.dumps({'ok': True, 'data': result})); return 0
    except (ValueError, KeyError, TypeError, OSError, tarfile.TarError) as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z][a-z0-9_]{1,79}', str(error)) else 'invalid_kernel_package'
        print(json.dumps({'ok': False, 'error': {'code': code, 'message': '内核包校验或安装失败'}})); return 1


if __name__ == '__main__':
    def cancelled(_signal, _frame):
        raise ValueError('installation_cancelled')
    signal.signal(signal.SIGTERM, cancelled)
    raise SystemExit(main())
