/* Hosted phone page: claims the single-use QR token, then uploads straight to the session. */
(function () {
  'use strict';
  var tr = (navigator.language || '').slice(0, 2) === 'tr';
  var T = tr ? {
    title: 'Dosyayı bilgisayarına gönder', pick: 'Fotoğraf veya belge seç', more: 'Bir dosya daha gönder',
    after: 'Bitti mi? Bilgisayarına dön ve forma devam et.', sending: 'Gönderiliyor', checking: 'Kontrol ediliyor…',
    accepted: 'Bilgisayara gönderildi', rejected: 'Reddedildi', allowed: 'İzin verilen', upTo: 'en fazla',
    noToken: 'Bu sayfayı açmak için bilgisayardaki QR kodu okutun.', failed: 'Gönderilemedi. Tekrar deneyin.',
  } : {
    title: 'Send a file to your computer', pick: 'Choose a photo or document', more: 'Send another file',
    after: 'Done? Go back to your computer and continue the form.', sending: 'Sending', checking: 'Checking…',
    accepted: 'Sent to your computer', rejected: 'Rejected', allowed: 'Allowed', upTo: 'up to',
    noToken: 'Scan the QR code on your computer to open this page.', failed: 'Could not send. Try again.',
  };
  var LABEL = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/heic': 'HEIC', 'image/webp': 'WEBP' };
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'crossupload.phoneToken';
  var phoneToken = null;

  document.documentElement.lang = tr ? 'tr' : 'en';
  document.title = T.title;
  $('title').textContent = T.title;
  $('pick-label').textContent = T.pick;
  $('after').textContent = T.after;

  function fail(message) {
    $('error').textContent = message;
    $('error').hidden = false;
    $('rules').hidden = true;
  }

  function size(b) { return b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }

  function row(name) {
    var li = document.createElement('li');
    var n = document.createElement('span'); n.className = 'name'; n.textContent = name;
    var s = document.createElement('span'); s.className = 'st';
    li.appendChild(n); li.appendChild(s);
    $('list').appendChild(li);
    return {
      set: function (status, text, reason) {
        s.className = 'st ' + status; s.textContent = text;
        if (reason) { var r = document.createElement('span'); r.className = 'reason'; r.textContent = reason; n.appendChild(r); }
      },
    };
  }

  function upload(file) {
    var r = row(file.name);
    r.set('checking', T.sending + ' 0%');
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', '/v1/phone/files');
    xhr.setRequestHeader('Authorization', 'Bearer ' + phoneToken);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) r.set('checking', e.loaded === e.total ? T.checking : T.sending + ' ' + Math.round(e.loaded / e.total * 100) + '%');
    };
    xhr.onload = function () {
      var body = {};
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (body.status === 'accepted') r.set('accepted', T.accepted);
      else r.set('rejected', T.rejected, body.reason || (body.error && body.error.message) || T.failed);
      $('pick-label').textContent = T.more;
      $('after').hidden = false;
    };
    xhr.onerror = function () { r.set('rejected', T.rejected, T.failed); };
    xhr.send(file);
  }

  function ready(limits) {
    var types = limits.allowedTypes.map(function (m) { return LABEL[m] || m; });
    $('rules').textContent = T.allowed + ': ' + types.join(', ') + ' · ' + T.upTo + ' ' + size(limits.maxFileSize);
    $('file').accept = limits.allowedTypes.join(',');
    $('pick').hidden = false;
    $('file').addEventListener('change', function () {
      Array.prototype.forEach.call($('file').files, upload);
      $('file').value = '';
    });
  }

  var pairToken = location.hash.slice(1);
  // Clear the secret from the address bar and history straight away.
  if (pairToken) history.replaceState(null, '', location.pathname);

  try { phoneToken = sessionStorage.getItem(KEY); } catch (e) { /* private mode */ }

  if (pairToken) {
    fetch('/v1/phone/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairToken: pairToken }) })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error.message); return b; }); })
      .then(function (b) {
        phoneToken = b.phoneToken;
        try { sessionStorage.setItem(KEY, phoneToken); } catch (e) { /* ignore */ }
        ready(b);
      })
      .catch(function (e) { fail(e.message); });
  } else if (phoneToken) {
    fetch('/v1/phone/session', { headers: { Authorization: 'Bearer ' + phoneToken } })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error.message); return b; }); })
      .then(ready)
      .catch(function (e) { fail(e.message); });
  } else {
    fail(T.noToken);
  }
})();
