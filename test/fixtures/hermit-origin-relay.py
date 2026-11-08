#!/usr/bin/env python3
"""把容器回环模拟上游转发到隔离测试地址，使流量经过标准透明出口。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import sys


class Relay(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        upstream = http.client.HTTPConnection('198.18.0.1', int(sys.argv[1]), timeout=30)
        headers = {key: value for key, value in self.headers.items() if key.lower() not in ('host', 'connection')}
        upstream.request('POST', self.path, body, headers)
        response = upstream.getresponse()
        payload = response.read()
        self.send_response(response.status)
        self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        upstream.close()

    def log_message(self, *_):
        pass


ThreadingHTTPServer(('127.0.0.1', 19081), Relay).serve_forever()
