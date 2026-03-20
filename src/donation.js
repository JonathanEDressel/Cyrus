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
