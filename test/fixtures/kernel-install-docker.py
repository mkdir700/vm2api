#!/usr/bin/env python3
"""Simulate the Docker boundary; retain real HTTP, package verification, and Unix health calls."""
import json
import os
from pathlib import Path
import socketserver
import sys
import threading
import uuid

root = Path(os.environ['KERNEL_INSTALL_FIXTURE'])
state_file = root / 'docker-state.json'
args = sys.argv[1:]
with (root / 'docker-commands.jsonl').open('a') as stream:
    stream.write(json.dumps(args) + '\n')
if args[0] == '-socket':
    (root / 'api-fixture.pid').write_text(str(os.getpid()))
    class ApiHealth(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.recv(65536)
            self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}')
    socketserver.UnixStreamServer(args[args.index('-socket') + 1], ApiHealth).serve_forever()
    raise SystemExit(0)
state = json.loads(state_file.read_text()) if state_file.exists() else {}

def save():
    state_file.write_text(json.dumps(state))

def find(name):
    for key, value in state.items():
        if key == name or value['Id'] == name:
            return key, value
    print('No such container: ' + name, file=sys.stderr)
    raise SystemExit(1)

if args[:2] == ['network', 'inspect']:
    print('172.29.0.0/24|172.29.0.1')
elif args[0] in ['pull', 'image', 'version']:
    print('fixture-image')
elif args[0] == 'inspect':
    key, item = find(args[-1])
    if '--format' not in args:
        print(json.dumps([item]))
    else:
        fmt = args[args.index('--format') + 1]
        if 'State.Running}}|' in fmt:
            print(f"{str(item['State']['Running']).lower()}|0|kin-eg-local||fixture-image|fixture|docker|{item['Config']['Labels'].get('kin.vm.role', '')}|false|{item['HostConfig']['RestartPolicy']['Name']}|[]|true")
        elif 'Config.Cmd' in fmt:
            print(json.dumps(['sleep', 'infinity']))
        elif 'HostConfig.Init' in fmt:
            print('true')
        elif 'Mounts' in fmt:
            print(json.dumps([{'Destination': '/opt/kin-kernel-packages', 'RW': False}]))
        else:
            print('{}')
elif args[0] == 'run':
    if (root / 'fail-run').exists():
        print('Injected candidate creation failure', file=sys.stderr)
        raise SystemExit(1)
    name = args[args.index('--name') + 1]
    labels = dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--label')
    state[name] = {'Id': 'fixture-' + uuid.uuid4().hex, 'State': {'Running': True}, 'Config': {'Labels': labels}, 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}}}
    save()
    print(state[name]['Id'])
elif args[0] == 'rename':
    key, item = find(args[1])
    state[args[2]] = state.pop(key)
    save()
elif args[0] in ['stop', 'start', 'update', 'rm']:
    key, item = find(args[-1])
    if args[0] == 'rm':
        del state[key]
    elif args[0] == 'update':
        item['HostConfig']['RestartPolicy']['Name'] = 'no'
    else:
        item['State']['Running'] = args[0] == 'start'
    save()
elif args[0] == 'exec':
    if 'python3' in args:
        print(json.dumps({'os': {'ID': 'ubuntu', 'VERSION_ID': '24.04'}, 'libc': 'glibc 2.39', 'arch': 'x86_64', 'tmux': '1' * 64}))
    elif any('/opt/kin-kernel-packages/' in arg for arg in args):
        run = root / 'vms/vm-sim-01/run'
        sock = run / 'kernel.sock'
        sock.unlink(missing_ok=True)
        class Health(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(65536)
                body = json.dumps({'ok': True, 'healthy': True, 'runtime_flavor': 'hermit', 'active_requests': 0, 'switch_ready': True, 'ready_slots': 1}).encode()
                try:
                    self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
                except BrokenPipeError:
                    pass
        server = socketserver.UnixStreamServer(str(sock), Health)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        sys.stdin.buffer.read()
        server.shutdown()
        server.server_close()
        sock.unlink(missing_ok=True)
    else:
        print('fixture')
else:
    print('Unsupported Docker operation', args, file=sys.stderr)
    raise SystemExit(1)
