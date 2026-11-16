/*! CrossUpload core widget · MIT License
 *
 *   <button type="button" id="upload">Upload a file</button>
 *   <input type="hidden" id="attachments" name="attachment_ids" value="[]">
 *   <script src="https://uploads.example.com/v1/widget.js"></script>
 *   <script>
 *     CrossUpload.attach({
 *       target: '#upload',
 *       sessionEndpoint: '/api/crossupload/session', // your backend, calls POST /v1/sessions
 *       resultInput: '#attachments',
 *       onComplete({ files }) { console.log(files); },
 *     });
 *   </script>
 *
 * No dependencies. The UI lives in a Shadow DOM so your page styles don't leak in.
 */
(function (global) {
  'use strict';

  var script = document.currentScript;
  var DEFAULT_SERVER = script && script.src ? new URL(script.src).origin : location.origin;

  var STRINGS = {
    en: {
      title: 'Upload a file', device: 'Choose from this device', drop: 'or drag files here',
      phone: 'Upload from your phone', scan: 'Scan with your phone camera. No app needed.',
      newCode: 'Show a new code', expired: 'This code has expired.', done: 'Done', close: 'Close',
      allowed: 'Allowed', upTo: 'up to', each: 'each', max: 'max', files: 'files',
      checking: 'Checking…', accepted: 'Added', rejected: 'Rejected', fromPhone: 'from phone',
      remove: 'Remove', loading: 'Preparing…', failed: 'Could not start the upload. Try again.',
    },
    tr: {
      title: 'Dosya yükle', device: 'Bu cihazdan seç', drop: 'veya dosyaları buraya sürükle',
      phone: 'Telefondan yükle', scan: 'Telefon kamerasıyla okut. Uygulama gerekmez.',
      newCode: 'Yeni kod göster', expired: 'Bu kodun süresi doldu.', done: 'Tamam', close: 'Kapat',
      allowed: 'İzin verilen', upTo: 'en fazla', each: 'dosya başına', max: 'en çok', files: 'dosya',
      checking: 'Kontrol ediliyor…', accepted: 'Eklendi', rejected: 'Reddedildi', fromPhone: 'telefondan',
      remove: 'Kaldır', loading: 'Hazırlanıyor…', failed: 'Yükleme başlatılamadı. Tekrar deneyin.',
    },
  };

  var LABEL = {
    'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/heic': 'HEIC',
    'image/webp': 'WEBP', 'image/gif': 'GIF', 'image/avif': 'AVIF', 'video/mp4': 'MP4',
    'video/quicktime': 'MOV', 'text/plain': 'TXT', 'text/csv': 'CSV', 'application/zip': 'ZIP',
  };

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(11,16,41,.55);display:flex;align-items:center;justify-content:center;padding:16px;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0b1029}',
    '.dialog{background:#fff;width:100%;max-width:720px;max-height:calc(100vh - 32px);overflow:auto;padding:24px;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.25)}',
    '.head{display:flex;justify-content:space-between;align-items:center;gap:12px}',
    'h2{margin:0;font-size:22px}',
    '.x{border:0;background:none;font-size:26px;line-height:1;cursor:pointer;color:inherit;padding:4px 8px}',
    '.rules{margin:4px 0 0;color:#545a72;font-size:14px}',
    '.grid{display:grid;grid-template-columns:1fr 220px;gap:16px;margin-top:18px}',
    '@media (max-width:620px){.grid{grid-template-columns:1fr}.phone{display:none}}',
    '.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:200px;border:2px dashed #b7bccb;border-radius:8px;padding:16px;text-align:center}',
    '.drop.over{border-color:#2747d9;background:#f2f5ff}',
    '.btn{font:inherit;font-weight:700;border:2px solid #0b1029;background:#0b1029;color:#fff;padding:10px 16px;border-radius:6px;cursor:pointer}',
    '.btn.ghost{background:#fff;color:#0b1029}',
    '.muted{color:#545a72;font-size:14px}',
    '.phone{border:1px solid #dfe2ea;border-radius:8px;padding:14px;text-align:center}',
    '.phone strong{display:block}',
    '.qr{width:180px;height:180px;margin:10px auto 6px;display:flex;align-items:center;justify-content:center}',
    '.qr svg{width:100%;height:100%}',
    'ul{list-style:none;margin:16px 0 0;padding:0}',
    'li{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #eceef3}',
    '.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.st{font-size:13px;font-weight:700;padding:2px 8px;border-radius:4px;background:#eceef3}',
    '.st.accepted{background:#0b1029;color:#fff}',
    '.st.rejected{background:#fde8e8;color:#9b1c1c}',
    '.reason{display:block;color:#9b1c1c;font-size:13px}',
    '.rm{border:0;background:none;cursor:pointer;color:#545a72;font:inherit;font-size:13px;text-decoration:underline}',
    '.foot{display:flex;justify-content:flex-end;margin-top:18px}',
  ].join('');

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function size(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function resolve(target) {
    return typeof target === 'string' ? document.querySelector(target) : target;
  }

  function attach(options) {
    var opts = options || {};
    var t = STRINGS[opts.locale] || STRINGS[(navigator.language || 'en').slice(0, 2)] || STRINGS.en;
    var server = (opts.server || DEFAULT_SERVER).replace(/\/+$/, '');
    var button = resolve(opts.target);
    var input = opts.resultInput ? resolve(opts.resultInput) : null;
    if (!button) throw new Error('CrossUpload: target not found');

    var session = null, source = null, files = [], removed = {}, host = null, ui = null, pairTimer = null, retry = null, destroyed = false;

    function emitError(code, message) {
      if (opts.onError) opts.onError({ code: code, message: message });
    }

    function accepted() {
      return files.filter(function (f) { return f.status === 'accepted' && !removed[f.id]; });
    }

    function sync() {
      if (input) {
        input.value = JSON.stringify(accepted().map(function (f) { return f.id; }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (opts.onChange) opts.onChange({ files: accepted() });
      render();
    }

    function upsert(file) {
      var i = files.findIndex(function (f) { return f.id === file.id; });
      if (i === -1) files.push(file); else files[i] = file;
      sync();
    }

    function start() {
      if (session) return Promise.resolve(session);
      return fetch(opts.sessionEndpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { if (!r.ok) throw new Error('session endpoint returned ' + r.status); return r.json(); })
        .then(function (s) {
          session = s;
          listen();
          return s;
        });
    }

    // Live file events. Each connection uses a fresh single-use ticket, so the client token
    // stays in headers. On a drop, get a new ticket and reconnect (the server replays the files).
    function listen() {
      if (destroyed) return;
      api('/events-ticket', { method: 'POST' }).then(function (res) {
        if (!res.ok || destroyed) throw new Error();
        source = new EventSource(server + '/v1/sessions/' + session.sessionId + '/events?ticket=' + encodeURIComponent(res.body.ticket));
        source.addEventListener('file', function (e) { upsert(JSON.parse(e.data)); });
        source.onerror = function () { source.close(); source = null; retry = setTimeout(listen, 3000); };
      }).catch(function () { retry = setTimeout(listen, 5000); });
    }

    function api(path, init) {
      init = init || {};
      init.headers = Object.assign({ Authorization: 'Bearer ' + session.clientToken }, init.headers || {});
      return fetch(server + '/v1/sessions/' + session.sessionId + path, init).then(function (r) {
        return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
      });
    }

    function uploadLocal(list) {
      Array.prototype.forEach.call(list, function (file) {
        var tempId = 'local_' + Math.random().toString(36).slice(2);
        if (file.size > session.maxFileSize) {
          upsert({ id: tempId, name: file.name, size: file.size, status: 'rejected', reason: t.upTo + ' ' + size(session.maxFileSize), source: 'device' });
          return;
        }
        upsert({ id: tempId, name: file.name, size: file.size, status: 'checking', source: 'device' });
        api('/files', { method: 'PUT', body: file, headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } })
          .then(function (res) {
            files = files.filter(function (f) { return f.id !== tempId; });
            if (res.body && res.body.id) upsert(res.body);
            else upsert({ id: tempId, name: file.name, size: file.size, status: 'rejected', reason: (res.body.error || {}).message, source: 'device' });
          })
          .catch(function () {
            upsert({ id: tempId, name: file.name, size: file.size, status: 'rejected', reason: t.failed, source: 'device' });
          });
      });
    }

    function showQr() {
      if (!ui) return;
      clearTimeout(pairTimer);
      ui.qr.textContent = t.loading;
      ui.qrNote.textContent = t.scan;
      ui.newCode.hidden = true;
      api('/pair', { method: 'POST' }).then(function (res) {
        if (!res.ok) throw new Error();
        // The SVG is generated by your CrossUpload server.
        ui.qr.innerHTML = res.body.qrSvg;
        ui.qr.querySelector('svg').setAttribute('aria-label', res.body.url);
        pairTimer = setTimeout(function () {
          ui.qr.textContent = '';
          ui.qrNote.textContent = t.expired;
          ui.newCode.hidden = false;
        }, new Date(res.body.expiresAt) - Date.now());
      }).catch(function () {
        ui.qr.textContent = '';
        ui.qrNote.textContent = t.failed;
        ui.newCode.hidden = false;
      });
    }

    function rules() {
      var types = session.allowedTypes.map(function (m) { return LABEL[m] || m.replace('.', '').toUpperCase(); });
      return t.allowed + ': ' + types.join(', ') + ' · ' + t.upTo + ' ' + size(session.maxFileSize) + ' ' + t.each + ' · ' + t.max + ' ' + session.maxFiles + ' ' + t.files;
    }

    function build() {
      host = el('div');
      var root = host.attachShadow({ mode: 'open' });
      root.appendChild(el('style', { text: CSS }));
      var picker = el('input', { type: 'file', multiple: '', hidden: '', accept: session.allowedTypes.join(',') });
      picker.addEventListener('change', function () { uploadLocal(picker.files); picker.value = ''; });
      var drop = el('div', { class: 'drop' }, [
        el('button', { class: 'btn', type: 'button', text: t.device, onclick: function () { picker.click(); } }),
        el('span', { class: 'muted', text: t.drop }), picker,
      ]);
      ['dragenter', 'dragover'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (n) { drop.addEventListener(n, function () { drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); uploadLocal(e.dataTransfer.files); });

      var qr = el('div', { class: 'qr', role: 'img' });
      var qrNote = el('p', { class: 'muted', text: t.scan });
      var newCode = el('button', { class: 'btn ghost', type: 'button', text: t.newCode, hidden: '', onclick: showQr });
      var list = el('ul', { 'aria-live': 'polite' });
      var dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.title }, [
        el('div', { class: 'head' }, [el('h2', { text: t.title }), el('button', { class: 'x', type: 'button', 'aria-label': t.close, text: '×', onclick: close })]),
        el('p', { class: 'rules', text: rules() }),
        el('div', { class: 'grid' }, [drop, el('div', { class: 'phone' }, [el('strong', { text: t.phone }), qr, qrNote, newCode])]),
        list,
        el('div', { class: 'foot' }, [el('button', { class: 'btn', type: 'button', text: t.done, onclick: done })]),
      ]);
      var backdrop = el('div', { class: 'backdrop' }, [dialog]);
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
      root.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      root.appendChild(backdrop);
      ui = { list: list, qr: qr, qrNote: qrNote, newCode: newCode, dialog: dialog };
    }

    function render() {
      if (!ui) return;
      ui.list.textContent = '';
      files.filter(function (f) { return !removed[f.id]; }).forEach(function (f) {
        var nameBox = el('span', { class: 'name' }, [document.createTextNode(f.name + (f.source === 'phone' ? ' · ' + t.fromPhone : '') + (f.size ? ' · ' + size(f.size) : ''))]);
        if (f.status === 'rejected' && f.reason) nameBox.appendChild(el('span', { class: 'reason', text: f.reason }));
        ui.list.appendChild(el('li', null, [
          nameBox,
          el('span', { class: 'st ' + f.status, text: t[f.status] || f.status }),
          f.status !== 'checking' ? el('button', { class: 'rm', type: 'button', text: t.remove, onclick: function () { removed[f.id] = true; sync(); } }) : null,
        ]));
      });
    }

    function open() {
      button.disabled = true;
      return start().then(function () {
        if (!host) build();
        document.body.appendChild(host);
        render();
        showQr();
        ui.dialog.querySelector('.btn').focus();
      }).catch(function (err) {
        emitError('session_failed', err.message);
      }).then(function () { button.disabled = false; });
    }

    function close() {
      clearTimeout(pairTimer);
      if (host && host.parentNode) host.parentNode.removeChild(host);
      button.focus();
    }

    function done() {
      close();
      if (opts.onComplete) opts.onComplete({ files: accepted() });
    }

    function onClick(e) { e.preventDefault(); open(); }
    button.addEventListener('click', onClick);

    return {
      open: open,
      close: close,
      files: accepted,
      destroy: function () {
        close();
        destroyed = true;
        clearTimeout(retry);
        button.removeEventListener('click', onClick);
        if (source) source.close();
      },
    };
  }

  global.CrossUpload = { attach: attach, version: '0.1.1' };
})(window);
