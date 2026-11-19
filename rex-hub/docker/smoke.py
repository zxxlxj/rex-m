import http.cookiejar, json, os, sys, urllib.error, urllib.request

origin = os.environ.get('PUBLIC_ORIGIN', 'http://localhost:8080')
token = os.environ['SETUP_TOKEN']
password = 'local-smoke-test-password-01'
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(path, payload=None, status=200, decoder=json.loads):
    headers = {'Origin': origin, 'Content-Type': 'application/json'}
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(origin + path, data=body, headers=headers)
    try:
        with client.open(req, timeout=15) as res:
            code, raw = res.status, res.read()
    except urllib.error.HTTPError as res:
        code, raw = res.status, res.read()
    assert code == status, (path, code, raw[:250])
    return decoder(raw)

assert request('/healthz')['ok']
assert b'REX Hub' in request('/', decoder=bytes)
request('/api/state', status=401)
assert not request('/api/session')['initialized']
request('/api/setup', {'token': token, 'password': password}, status=201)
assert request('/api/session')['authenticated']
request('/api/category', {'name': '测试'})
cat = request('/api/state')['categories'][0]['id']
request('/api/distribution', {'key': 'test-hub', 'title': 'Smoke', 'mode': 'rules', 'categoryIds': [cat], 'enabled': True, 'publish': True, 'confirmEmpty': True})
module = 'var WidgetMetadata = {id:"rex.smoke",title:"Smoke",version:"1.0.0",requiredVersion:"0.0.6",modules:[]};'
src = request('/api/source', {'categoryId': cat, 'files': [{'name': 'smoke.js', 'text': module}]}, status=201)['source']
manifest = request('/s/test-hub.rex')
assert manifest['widgets'][0]['id'] == 'rex.smoke'
path = manifest['widgets'][0]['url'].removeprefix(origin)
assert request(path, decoder=bytes).decode() == module
request('/api/source/batch', {'ids': [src['id']], 'action': 'delete'})
assert request('/s/test-hub.rex')['widgets'] == []
request(path, status=404)
pack = request('/api/badges/import', {'mode': 'host', 'filename': 'smoke.json', 'text': '{"groups":[],"filters":[]}'})['id']
request('/api/badges/active', {'id': pack})
assert request('/badge.json')['filters'] == []
request('/api/badges/update', {'id': pack, 'delete': True})
request('/badge.json', status=404, decoder=bytes)
request('/api/password', {'currentPassword': password, 'newPassword': 'second-smoke-password-02'})
assert request('/api/session')['authenticated']
request('/api/logout', {})
assert not request('/api/session')['authenticated']
print('PASS: auth, UI, categories, upload, automatic publish, file cleanup, badges, password change')
