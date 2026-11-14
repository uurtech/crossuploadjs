(function () {
  'use strict';
  var count = document.getElementById('count');
  CrossUpload.attach({
    target: '#upload',
    sessionEndpoint: '/demo/session',
    resultInput: '#attachments',
    onChange: function (e) {
      count.textContent = e.files.length ? e.files.map(function (f) { return f.name; }).join(', ') : 'No files yet';
    },
    onError: function (e) { count.textContent = e.message; },
  });

  document.getElementById('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(e.target);
    fetch('/demo/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: data.get('name'), attachment_ids: JSON.parse(data.get('attachment_ids')) }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      var box = document.getElementById('result');
      box.hidden = false;
      box.textContent = '';
      var h = document.createElement('strong');
      h.textContent = res.ok ? 'Received ' + res.files.length + ' verified file(s) from ' + res.name : 'Some file IDs did not verify';
      box.appendChild(h);
      var pre = document.createElement('pre');
      pre.textContent = JSON.stringify(res.files, null, 2);
      box.appendChild(pre);
    });
  });
})();
