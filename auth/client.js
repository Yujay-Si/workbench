(function () {
  'use strict';
  var desktop = window.nexusDesktop;

  function webRequest(method, route, body) {
    return fetch(route, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.json().then(function (result) {
        return Object.assign({ ok: response.ok, status: response.status }, result);
      });
    }).catch(function (error) {
      return { ok: false, code: 'NETWORK', error: '连接工作台服务失败：' + error.message };
    });
  }

  window.nexusAccount = Object.freeze(desktop ? {
    serverInfo: desktop.accountServerInfo,
    saveServer: desktop.accountServerSave,
    register: desktop.accountRegister,
    login: desktop.accountLogin,
    logout: desktop.accountLogout,
    session: desktop.accountSession,
    workspace: desktop.accountWorkspace,
    save: desktop.accountSave
  } : {
    serverInfo: function () { return Promise.resolve({ url: location.origin }); },
    saveServer: function () { return Promise.reject(new Error('浏览器版服务器地址由当前网址决定')); },
    register: function (username, password) { return webRequest('POST', '/api/register', { username: username, password: password }); },
    login: function (username, password) { return webRequest('POST', '/api/login', { username: username, password: password }); },
    logout: function () { return webRequest('POST', '/api/logout', {}); },
    session: function () { return webRequest('GET', '/api/session'); },
    workspace: function () { return webRequest('GET', '/api/workspace'); },
    save: function (revision, data) { return webRequest('PUT', '/api/workspace', { revision: revision, data: data }); }
  });
})();
