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
assert 'state' not in request('/api/bootstrap')
request('/api/setup', {'token': token, 'password': password}, status=201)
assert request('/api/session')['authenticated']
request('/api/category', {'name': '测试'})
assert request('/api/bootstrap')['state']['categories'][0]['name'] == '测试'
cat = request('/api/state')['categories'][0]['id']
request('/api/distribution', {'key': 'test-hub', 'title': 'Smoke', 'mode': 'rules', 'categoryIds': [cat], 'enabled': True, 'publish': True, 'confirmEmpty': True})
module = 'var WidgetMetadata = {id:"rex.smoke",title:"Smoke",author:"Example Author",version:"1.0.0",requiredVersion:"0.0.7",contentType:"music",continuousPlay:false,modules:[]};'
src = request('/api/source', {'categoryId': cat, 'files': [{'name': 'smoke.js', 'text': module}]}, status=201)['source']
assert src['author'] == 'Example Author'
assert 'effectiveCategoryId' not in src['modules'][0]
manifest = request('/s/test-hub.rex')
assert manifest['widgets'][0]['id'] == 'rex.smoke'
assert manifest['widgets'][0]['contentType'] == 'music' and manifest['widgets'][0]['continuousPlay'] is False
path = manifest['widgets'][0]['url'].removeprefix(origin)
assert request(path, decoder=bytes).decode() == module
request('/api/category', {'name': '新分类'})
new_cat = request('/api/state')['categories'][1]['id']
refs = [{'sourceId': src['id'], 'id': 'rex.smoke'}]
assert request('/api/module/batch-category', {'modules': refs, 'categoryId': new_cat})['count'] == 1
assert request('/s/test-hub.rex')['widgets'] == []
request('/api/module/batch-category', {'modules': refs, 'categoryId': ''})
assert len(request('/s/test-hub.rex')['widgets']) == 1
rule = {'enabled': True, 'contentTypes': ['music', ' music ', 'other'], 'moduleName': ' SMOKE，other ', 'sourceAuthor': 'EXAMPLE'}
request('/api/category', {'id': new_cat, 'autoRule': rule})
state = request('/api/state')
assert state['categories'][1]['autoRule'] == {'enabled': True, 'contentTypes': ['music'], 'moduleName': 'SMOKE，other', 'moduleAuthor': '', 'sourceName': '', 'sourceAuthor': 'EXAMPLE'}
assert state['sources'][0]['modules'][0]['effectiveCategoryId'] == new_cat
assert request('/s/test-hub.rex')['widgets'] == []
request('/api/module/update', {'sourceId': src['id'], 'id': 'rex.smoke', 'categoryId': cat})
assert request('/api/state')['sources'][0]['modules'][0]['effectiveCategoryId'] == cat
assert len(request('/s/test-hub.rex')['widgets']) == 1
request('/api/module/update', {'sourceId': src['id'], 'id': 'rex.smoke', 'categoryId': ''})
assert request('/api/state')['sources'][0]['modules'][0]['effectiveCategoryId'] == new_cat
assert request('/s/test-hub.rex')['widgets'] == []
request('/api/category', {'id': new_cat, 'autoRule': {'enabled': False}})
assert request('/api/state')['sources'][0]['modules'][0]['effectiveCategoryId'] == cat
assert len(request('/s/test-hub.rex')['widgets']) == 1
request('/api/source/update', {'id': src['id'], 'categoryId': new_cat})
assert request('/s/test-hub.rex')['widgets'] == []
request('/api/source/update', {'id': src['id'], 'categoryId': cat})
assert len(request('/s/test-hub.rex')['widgets']) == 1
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
