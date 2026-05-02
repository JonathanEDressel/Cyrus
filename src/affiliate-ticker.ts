(function () {
  interface TickerEntry {
    icon: string;
    iconColorClass: string;
    label: string;
    description: string;
    link: string;
  }

  const ENTRIES: TickerEntry[] = [
    // {
    //   icon: 'fa-solid fa-shield-halved',
    //   iconColorClass: 'nord',
    //   label: 'NordVPN',
    //   description: 'Encrypt your connection while trading',
    //   link: 'https://go.nordvpn.net/aff_c?offer_id=15&aff_id=143568&url_id=902',
    // },
    // {
    //   icon: 'fa-solid fa-key',
    //   iconColorClass: 'nord',
    //   label: 'NordPass',
    //   description: 'Secure your API keys & passwords',
    //   link: 'https://go.nordpass.io/aff_c?offer_id=488&aff_id=143568&url_id=9356',
    // },
  ];

  const INTERVAL_MS = 5000;

  let current = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentCard: HTMLElement | null = null;

  function esc(str: string): string {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function buildCard(entry: TickerEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'affiliate-ticker-card';
    card.innerHTML = `
      <span class="affiliate-ticker-icon ${esc(entry.iconColorClass)}">
        <i class="${esc(entry.icon)}"></i>
      </span>
      <span class="affiliate-ticker-label">${esc(entry.label)}</span>
      <span class="affiliate-ticker-sep">—</span>
      <span class="affiliate-ticker-desc">${esc(entry.description)}</span>
      <a href="${esc(entry.link)}" class="affiliate-ticker-link" target="_blank" rel="noopener noreferrer">Try it</a>
    `;
    return card;
  }

  function showEntry(index: number): void {
    const ticker = document.getElementById('affiliate-ticker');
    if (!ticker) return;

    const entry = ENTRIES[index];

    // Fade out existing card
    if (currentCard) {
      const old = currentCard;
      old.classList.add('hiding');
      old.classList.remove('visible');
      setTimeout(() => old.remove(), 420);
    }

    // Build and fade in new card
    const card = buildCard(entry);
    ticker.appendChild(card);
    currentCard = card;

    // Trigger reflow so transition plays
    void card.offsetWidth;
    card.classList.add('visible');
  }

  function start(): void {
    if (ENTRIES.length === 0) return;
    showEntry(current);
    timer = setInterval(() => {
      current = (current + 1) % ENTRIES.length;
      showEntry(current);
    }, INTERVAL_MS);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Start once the topbar is visible (app sidebar shown)
  const observer = new MutationObserver(() => {
    const panel = document.getElementById('exchange-panel');
    if (!panel) return;
    if (!panel.classList.contains('d-none')) {
      if (timer === null) start();
    } else {
      stop();
    }
  });

  // Watch for exchange-panel visibility changes
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('exchange-panel');
    if (panel) {
      observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
      // If already visible on load
      if (!panel.classList.contains('d-none')) start();
    }
  });
})();
