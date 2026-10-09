import json, urllib.request

BASE = 'http://127.0.0.1:8787'

def call(method, path, payload=None):
    body = json.dumps(payload).encode('utf-8') if payload else None
    req = urllib.request.Request(BASE + path, data=body, method=method,
                                 headers={'Content-Type': 'application/json'} if body else {})
    try:
        r = urllib.request.urlopen(req, timeout=180)
        return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8'))

# 1. health
s, d = call('GET', '/api/v1/health')
print('[1] health:', s, d)

# 2. models
s, d = call('GET', '/api/v1/models')
print('[2] models:', s, json.dumps(d, ensure_ascii=False))

# 3. 本地千问路由
s, d = call('POST', '/api/v1/chat', {
    'model': 'local_agri',
    'messages': [{'role': 'user', 'content': '用一句话回答：你是谁？'}]
})
print('[3] local_agri ->', s)
print('    answer:', d.get('answer', d.get('error')))
print('    model:', d.get('model'), '| provider:', d.get('provider'))

# 4. 智谱路由（官方免费模型 glm-4.7-flash）
s, d = call('POST', '/api/v1/chat', {
    'model': 'glm-4.7-flash',
    'messages': [{'role': 'user', 'content': '用一句话回答：你是谁？'}]
})
print('[4] glm-4.7-flash ->', s)
print('    answer:', d.get('answer', d.get('error')))
print('    model:', d.get('model'), '| provider:', d.get('provider'))
