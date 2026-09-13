/* Click any Mermaid diagram to open it in a zoomable lightbox (pan + wheel/buttons/keys).
   Self-contained, no external deps, and self-styling: the overlay CSS is injected by this
   script (see injectStyles), so the lightbox can never be left invisible by a stale/cached
   stylesheet — the styles always travel with this file.

   Binding via EVENT DELEGATION on document (not per-element): Material for MkDocs renders
   Mermaid by REPLACING the static `<pre class="mermaid">` with a fresh `<div class="mermaid">`,
   which would discard any listener bound to the original element. Delegation + closest() finds
   the rendered diagram at click time, so it survives that swap and instant navigation alike. */
(function () {
  var overlay, stage, content,
      scale = 1, tx = 0, ty = 0,
      dragging = false, startX = 0, startY = 0, built = false;

  function injectStyles() {
    if (document.getElementById('mz-styles')) return;
    var css =
      '.md-typeset .mermaid{cursor:zoom-in}' +
      'body.mz-lock{overflow:hidden}' +
      '.mz-overlay{position:fixed;inset:0;z-index:2147483000;display:none;background:rgba(12,14,18,.88)}' +
      '.mz-overlay.mz-open{display:block}' +
      '.mz-bar{position:absolute;top:14px;right:16px;z-index:2;display:flex;gap:8px}' +
      '.mz-btn{width:40px;height:40px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.10);' +
        'color:#fff;border-radius:8px;font-size:20px;line-height:1;cursor:pointer;display:flex;' +
        'align-items:center;justify-content:center}' +
      '.mz-btn:hover{background:rgba(255,255,255,.22)}' +
      '.mz-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'overflow:hidden;cursor:grab}' +
      '.mz-stage.mz-grabbing{cursor:grabbing}' +
      '.mz-content{transform-origin:center center;will-change:transform;' +
        'background:var(--md-default-bg-color,#fff);border-radius:12px;padding:22px}' +
      '.mz-content svg{display:block}';
    var st = document.createElement('style');
    st.id = 'mz-styles';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildOverlay() {
    if (built) return;
    built = true;
    injectStyles();
    overlay = document.createElement('div');
    overlay.className = 'mz-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Diagram viewer');
    overlay.innerHTML =
      '<div class="mz-bar">' +
        '<button class="mz-btn" data-act="out" aria-label="Zoom out" title="Zoom out">−</button>' +
        '<button class="mz-btn" data-act="reset" aria-label="Reset" title="Reset (0)">⤡</button>' +
        '<button class="mz-btn" data-act="in" aria-label="Zoom in" title="Zoom in">+</button>' +
        '<button class="mz-btn" data-act="close" aria-label="Close" title="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="mz-stage"><div class="mz-content"></div></div>';
    document.body.appendChild(overlay);
    stage = overlay.querySelector('.mz-stage');
    content = overlay.querySelector('.mz-content');

    overlay.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'in') zoom(1.25);
      else if (act === 'out') zoom(0.8);
      else if (act === 'reset') reset();
      else if (act === 'close' || e.target === stage || e.target === overlay) close();
    });
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    stage.addEventListener('mousedown', function (e) {
      dragging = true; startX = e.clientX - tx; startY = e.clientY - ty;
      stage.classList.add('mz-grabbing');
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      tx = e.clientX - startX; ty = e.clientY - startY; apply();
    });
    window.addEventListener('mouseup', function () {
      dragging = false; if (stage) stage.classList.remove('mz-grabbing');
    });
    document.addEventListener('keydown', function (e) {
      if (!overlay.classList.contains('mz-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') zoom(1.25);
      else if (e.key === '-' || e.key === '_') zoom(0.8);
      else if (e.key === '0') reset();
    });
  }

  function apply() {
    content.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }
  function zoom(f) { scale = Math.min(Math.max(scale * f, 0.2), 12); apply(); }
  function reset() { scale = 1; tx = 0; ty = 0; apply(); }

  function open(svg) {
    buildOverlay();
    content.innerHTML = '';
    var clone = svg.cloneNode(true);
    clone.removeAttribute('style');
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.style.width = 'min(1200px, 92vw)';
    clone.style.height = 'auto';
    clone.style.maxWidth = 'none';
    content.appendChild(clone);
    reset();
    overlay.classList.add('mz-open');
    document.body.classList.add('mz-lock');
  }
  function close() {
    overlay.classList.remove('mz-open');
    document.body.classList.remove('mz-lock');
  }

  // Inject styles as soon as possible so a hover cursor / overlay rules exist before any click.
  if (document.head || document.documentElement) injectStyles();

  // One delegated listener — no per-element binding to lose.
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    if (overlay && overlay.contains(e.target)) return;   // clicks inside the viewer
    var m = e.target.closest('.md-typeset .mermaid');
    if (!m) return;
    var svg = m.querySelector('svg');
    if (svg) open(svg);
  });
})();
