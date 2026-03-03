// input: localStorage, navigator.language, /locales/*.json
// output: CliHub.i18n namespace + t() translation function
// pos: i18n module, loaded before other modules that use t()

'use strict';

CliHub.i18n = {
  locale: localStorage.getItem('clihub-lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en'),
  messages: {},
  ready: false,

  async load(locale) {
    if (locale) this.locale = locale;
    try {
      const res = await fetch('/locales/' + this.locale + '.json');
      this.messages = await res.json();
      this.ready = true;
      localStorage.setItem('clihub-lang', this.locale);
    } catch (e) {
      console.error('i18n load failed:', e);
    }
  },

  t(key, params) {
    var val = this.messages[key] || key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        val = val.replace('{' + k + '}', params[k]);
      });
    }
    return val;
  },

  applyToDOM() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      el.textContent = CliHub.i18n.t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = CliHub.i18n.t(el.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = CliHub.i18n.t(el.getAttribute('data-i18n-title'));
    });
    document.documentElement.lang = this.locale === 'zh' ? 'zh-CN' : 'en';
  },

  async switchTo(locale) {
    await this.load(locale);
    this.applyToDOM();
  },
};

// Shortcut
CliHub.t = function (key, params) {
  return this.i18n.t(key, params);
};
