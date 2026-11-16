(function() {
  const toggle = document.getElementById('donation-toggle');
  const modal = document.getElementById('donation-modal');
  const close = document.getElementById('donation-close');
  
  toggle?.addEventListener('click', () => {
    modal?.classList.toggle('d-none');
  });
  
  close?.addEventListener('click', () => {
    modal?.classList.add('d-none');
  });

  // Heartbeat in short bursts: .is-beating plays one double-beat (and a ring)
  // every few seconds, then comes off so no animation is left running between
  // beats (see the .donation-toggle comment in main.css for why that matters).
  // Skipped while the window is hidden, the widget is off-screen or turned off,
  // the modal is open, or the user prefers reduced motion.
  const widget = document.getElementById('donation-widget');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const BEAT_EVERY_MS = 6000;
  const BEAT_FOR_MS = 1600;
  function beat() {
    if (!widget || document.hidden || reduceMotion.matches) return;
    if (widget.getClientRects().length === 0) return;       // hidden (d-none / turned off)
    if (modal && !modal.classList.contains('d-none')) return; // already open
    widget.classList.add('is-beating');
    setTimeout(() => widget.classList.remove('is-beating'), BEAT_FOR_MS);
  }
  setTimeout(beat, 2500);
  setInterval(beat, BEAT_EVERY_MS);

  document.addEventListener('click', (e) => {
    const typeBtn = e.target.closest('.giving-type-btn');
    if (typeBtn) {
      document.querySelectorAll('.giving-type-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.giving-panel').forEach(p => p.classList.remove('active'));
      typeBtn.classList.add('active');
      const type = typeBtn.getAttribute('data-type');
      document.getElementById(`giving-${type}`)?.classList.add('active');
      return;
    }

    const copyBtn = e.target.closest('.copy-btn');
    if (!copyBtn) return;

    const textToCopy = copyBtn.getAttribute('data-copy');
    if (!textToCopy) return;

    navigator.clipboard.writeText(textToCopy).then(() => {
      const icon = copyBtn.querySelector('i');
      const originalClass = icon.className;
      
      icon.className = 'fa-solid fa-check';
      copyBtn.classList.add('copied');
      
      setTimeout(() => {
        icon.className = originalClass;
        copyBtn.classList.remove('copied');
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy:', err);
      const textArea = document.createElement('textarea');
      textArea.value = textToCopy;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        const icon = copyBtn.querySelector('i');
        const originalClass = icon.className;
        icon.className = 'fa-solid fa-check';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          icon.className = originalClass;
          copyBtn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Fallback copy failed:', err);
      }
      document.body.removeChild(textArea);
    });
  });
})();
