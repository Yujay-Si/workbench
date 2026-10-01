const assert = require('node:assert/strict');
const test = require('node:test');
const i18n = require('../i18n/messages.js');

test('language module covers the account, workbench, and native close controls', () => {
  for (const source of ['登录', '注册须知', '首页', '任务管理', '应用中心', '备忘录',
    '版本与更新', '选择关闭方式', '仅关闭窗口，后台运行', '关闭此软件']) {
    assert.notEqual(i18n.t(source, 'en-US'), source, source);
    assert.equal(i18n.t(source, 'zh-CN'), source);
  }
  assert.equal(i18n.normalize('invalid'), 'zh-CN');
});

test('translated templates preserve the supplied account name and count', () => {
  assert.equal(i18n.t('你好，{name}', 'en-US', { name: '<Alice>' }), 'Hello, <Alice>');
  assert.equal(i18n.t('共 {count} 项', 'en-US', { count: 3 }), '3 items');
});
