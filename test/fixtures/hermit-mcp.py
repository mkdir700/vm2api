#!/usr/bin/env python3
"""Synthetic stdio MCP server for the isolated outer-result E2E fixture."""
import argparse
import base64
import json
import hashlib
import struct
from pathlib import Path
import sys
import zlib

parser = argparse.ArgumentParser()
parser.add_argument('receipt', type=Path)
parser.add_argument('state_path', type=Path, nargs='?')
parser.add_argument('--name', default='ExternalProbe')
parser.add_argument('--tool-error', action='store_true')
parser.add_argument('--read-only', action='store_true')
parser.add_argument('--result-kind', choices=['text', 'image', 'structured', 'resource'], default='text')
parser.add_argument('--elicitation', action='store_true')
parser.add_argument('--echo-label', action='store_true')
parser.add_argument('--error-label')
args = parser.parse_args()
receipt = args.receipt
pending = None
for line in sys.stdin:
    request = json.loads(line)
    resumed = False
    if request.get('id') == 'hermit-elicitation-1' and 'method' not in request:
        (receipt.parent / 'mcp-elicitation-response.json').write_text(json.dumps(request, indent=2) + '\n')
        elicitation = request.get('result', {})
        request, pending, resumed = pending, None, True
        if request is None:
            raise ValueError('Unexpected elicitation response')
    if 'id' not in request:
        continue
    method = request.get('method')
    if method == 'initialize':
        (receipt.parent / 'mcp-initialize-request.json').write_text(json.dumps(request, indent=2) + '\n')
        result = {'protocolVersion': '2025-06-18' if args.elicitation else '2024-11-05', 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'hermit-fixture', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': args.name, 'description': 'Return an isolated fixture receipt',
                             'inputSchema': {'type': 'object', 'properties': {'label': {'type': 'string'}},
                                             'required': ['label']}}]}
        if args.read_only:
            result['tools'][0]['annotations'] = {'readOnlyHint': True}
    elif method == 'tools/call':
        if not resumed:
            with receipt.open('a') as output:
                output.write(json.dumps(request['params']) + '\n')
        if args.elicitation and not resumed:
            pending = request
            outgoing = {'jsonrpc': '2.0', 'id': 'hermit-elicitation-1', 'method': 'elicitation/create',
                        'params': {'mode': 'form', 'message': 'BATCH_ELICITATION_CONFIRM',
                                   'requestedSchema': {'type': 'object', 'properties': {
                                       'approved': {'type': 'boolean'}}, 'required': ['approved']}}}
            (receipt.parent / 'mcp-elicitation-request.json').write_text(json.dumps(outgoing, indent=2) + '\n')
            print(json.dumps(outgoing), flush=True)
            continue
        result = {'content': [{'type': 'text', 'text': 'P1_DYNAMIC_MCP_RESULT'}], 'isError': False}
        if args.echo_label:
            result['content'][0]['text'] = json.dumps({'receipt': 'P1_DYNAMIC_MCP_RESULT', 'label': request['params']['arguments']['label']}, sort_keys=True)
        if args.elicitation:
            result = {'content': [{'type': 'text', 'text': json.dumps({'elicitation': elicitation}, sort_keys=True)}],
                      'isError': elicitation.get('action') != 'accept'}
        if args.error_label and request['params']['arguments'].get('label') == args.error_label:
            result = {'content': [{'type': 'text', 'text': json.dumps({
                'receipt': 'FOLLOWUP_EXPECTED_MCP_FAILURE', 'label': args.error_label}, sort_keys=True)}], 'isError': True}
        if args.tool_error:
            result = {'content': [{'type': 'text', 'text': 'BATCH_EXPECTED_MCP_FAILURE'}], 'isError': True}
        if args.result_kind == 'image':
            def chunk(kind, data):
                return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
            png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 2, 2, 8, 2, 0, 0, 0)) +
                   chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\x00\xff\x00' * 2)) + chunk(b'IEND', b''))
            result['content'].append({'type': 'image', 'mimeType': 'image/png',
                                      'data': base64.b64encode(png).decode()})
        elif args.result_kind == 'structured':
            result['structuredContent'] = {'receipt': 'BATCH_STRUCTURED', 'values': [1, 2], 'ok': True}
            result['content'] = [{'type': 'text', 'text': json.dumps(result['structuredContent'])}]
        elif args.result_kind == 'resource':
            result['content'].append({'type': 'resource', 'resource': {'uri': 'hermit://fixture/result',
                                      'mimeType': 'text/plain', 'text': 'BATCH_RESOURCE_TEXT'}})
        if args.state_path:
            path = args.state_path
            path.write_text('P1_MCP_STATE_FILE\n')
            content = path.read_bytes()
            result['_meta'] = {'anthropic/readFileStateChanges': [
                {'path': str(path), 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)}]}
            (receipt.parent / 'mcp-state-response.json').write_text(json.dumps(result, indent=2) + '\n')
        (receipt.parent / 'mcp-original-result.json').write_text(json.dumps(result, indent=2) + '\n')
        if args.echo_label:
            with (receipt.parent / 'mcp-results.jsonl').open('a') as output:
                output.write(json.dumps({'arguments': request['params']['arguments'], 'result': result}) + '\n')
    elif method == 'ping':
        result = {}
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                          'error': {'code': -32601, 'message': 'Unknown fixture method'}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
