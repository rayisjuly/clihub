// input: CliHub namespace
// output: Image compression + upload + preview + paste/drag/attach
// pos: Frontend image handling module

'use strict';

CliHub._pendingImages = []; // [{dataUrl, width, height}]

// ─── Compress image ───

CliHub.compressImage = function (file, maxLong) {
  maxLong = maxLong || 1024;
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        var scale = Math.min(1, maxLong / Math.max(w, h));
        var nw = Math.round(w * scale), nh = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = nw;
        canvas.height = nh;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, nw, nh);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.8), width: nw, height: nh });
      };
      img.onerror = function () { reject(new Error(CliHub.t('img.loadFailed'))); };
      img.src = e.target.result;
    };
    reader.onerror = function () { reject(new Error(CliHub.t('img.readFailed'))); };
    reader.readAsDataURL(file);
  });
};

// ─── Upload image to server ───

CliHub.uploadImage = function (sessionId, dataUrl) {
  return fetch('/api/upload', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders()),
    body: JSON.stringify({ sessionId: sessionId, dataUrl: dataUrl }),
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (d) { throw new Error(d.error); });
    return r.json();
  });
};

// ─── Add pending image ───

CliHub.addPendingImage = function (file) {
  var hub = this;
  if (hub._pendingImages.length >= 5) {
    hub.addSystemMessage(hub.t('img.maxImages'));
    return;
  }
  hub.compressImage(file).then(function (result) {
    hub._pendingImages.push(result);
    hub.renderImagePreview();
  }).catch(function (err) {
    hub.addSystemMessage(hub.t('img.processFailed', { error: err.message }));
  });
};

// ─── Remove pending image ───

CliHub.removePendingImage = function (index) {
  this._pendingImages.splice(index, 1);
  this.renderImagePreview();
};

// ─── Clear all pending images ───

CliHub.clearPendingImages = function () {
  this._pendingImages = [];
  this.renderImagePreview();
};

// ─── Render preview bar ───

CliHub.renderImagePreview = function () {
  var container = this.el.imagePreview;
  if (!container) return;
  container.innerHTML = '';
  var hub = this;

  if (this._pendingImages.length === 0) {
    container.classList.remove('visible');
    return;
  }
  container.classList.add('visible');

  this._pendingImages.forEach(function (item, i) {
    var thumb = document.createElement('div');
    thumb.className = 'preview-thumb';
    var img = document.createElement('img');
    img.src = item.dataUrl;
    var btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = '\u00d7';
    btn.addEventListener('click', function () { hub.removePendingImage(i); });
    thumb.appendChild(img);
    thumb.appendChild(btn);
    container.appendChild(thumb);
  });

  // Enable send button when images are present
  this.el.sendBtn.disabled = false;
};

// ─── Handle file list ───

CliHub.handleImageFiles = function (files) {
  for (var i = 0; i < files.length; i++) {
    if (files[i].type.startsWith('image/')) {
      this.addPendingImage(files[i]);
    }
  }
};

// ─── Event bindings (called in DOMContentLoaded) ───

CliHub.initImageHandlers = function () {
  var hub = this;

  // Attach button
  hub.el.attachBtn.addEventListener('click', function () {
    hub.el.imageInput.click();
  });

  // File selection
  hub.el.imageInput.addEventListener('change', function () {
    hub.handleImageFiles(this.files);
    this.value = '';
  });

  // Paste
  hub.el.msgInput.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        hub.addPendingImage(items[i].getAsFile());
        return;
      }
    }
  });

  // Drag and drop
  var inputArea = hub.el.inputArea;
  inputArea.addEventListener('dragover', function (e) {
    e.preventDefault();
    inputArea.classList.add('drag-over');
  });
  inputArea.addEventListener('dragleave', function () {
    inputArea.classList.remove('drag-over');
  });
  inputArea.addEventListener('drop', function (e) {
    e.preventDefault();
    inputArea.classList.remove('drag-over');
    hub.handleImageFiles(e.dataTransfer.files);
  });
};
