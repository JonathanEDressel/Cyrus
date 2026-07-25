(function () {

interface AffiliateProduct {
  name: string;
  description: string;
  link: string;
  /** Optional short pitch shown on the button, e.g. "Save 70%" */
  badge?: string;
}

interface Affiliate {
  name: string;
  category: string;
  iconClass: string;
  /** Maps to a .partner-icon-<key> rule in affiliates.css for brand tinting. */
  iconColorClass: string;
  tags: string[];
  why: string;
  products: AffiliateProduct[];
}

/**
 * Partner list. Only real, signed-up affiliate links belong here — an
 * unaffiliated homepage URL dressed up as a recommendation earns nothing and
 * costs trust. Add new entries with the template at the bottom; the layout
 * groups by `category` and reflows on its own.
 */
const AFFILIATES: Affiliate[] = [
  {
    name: 'Kraken',
    category: 'Exchanges',
    iconClass: 'fa-solid fa-building-columns',
    iconColorClass: 'kraken',
    tags: ['Spot Trading', 'Withdrawal API', 'Address Whitelist'],
    why: `Kraken is the exchange Cyrus supports most completely. It's the only one of the three whose API
          exposes <strong>whitelisted withdrawal addresses</strong>, which is what makes auto-withdraw rules
          possible &mdash; on Coinbase and Binance you can convert, but you can't send funds out.
          If you want the full automation set, this is where to run it.`,
    products: [
      {
        name: 'Open a Kraken account',
        description: 'Spot trading with the API access Cyrus needs for balance, price, convert, and withdraw automations.',
        link: 'https://invite.kraken.com/JDNW/mjewpya5',
      },
    ],
  },
  {
    name: 'Coinbase',
    category: 'Exchanges',
    iconClass: 'fa-solid fa-arrow-right-arrow-left',
    iconColorClass: 'coinbase',
    tags: ['Spot Trading', 'Convert Actions', 'Beginner Friendly'],
    why: `The easiest place to start if you're new to this. Cyrus supports Coinbase Advanced for
          <strong>price and balance triggers and convert actions</strong> &mdash; so take-profit and
          swap-on-threshold rules work fine. Auto-withdraw rules don't, because Coinbase's API doesn't
          expose a withdrawal address book; for those you'll want Kraken. Support is still in beta.`,
    products: [
      {
        name: 'Coinbase Advanced',
        description: 'The trading interface Cyrus actually connects to — this is the one to use for price, balance, and convert automations.',
        link: 'https://advanced.coinbase.com/join/EC99C6S?src=referral-link',
      },
      {
        name: 'Coinbase',
        description: 'The standard app, if you just want somewhere simple to buy and hold before automating anything.',
        link: 'https://coinbase.com/join/HB7T7JN?src=referral-link',
      },
    ],
  },
  {
    name: 'Tangem',
    category: 'Hardware Wallets',
    iconClass: 'fa-solid fa-credit-card',
    iconColorClass: 'tangem',
    tags: ['Cold Storage', 'Self-Custody', 'Tap to Sign'],
    why: `An auto-withdraw rule needs somewhere to send funds &mdash; and the whole point of sweeping an
          exchange balance is that it ends up somewhere <strong>you</strong> hold the keys to. Tangem is a
          hardware wallet in card form: tap it to your phone to sign, no cable and no battery, and it ships
          as a set so you have a backup card rather than a phrase on a piece of paper.`,
    products: [
      {
        name: 'Get a Tangem wallet',
        description: 'A withdrawal destination you control, for balance-threshold and order-filled sweep rules.',
        link: 'https://tangem.com/invite/366PAR',
      },
    ],
  },
  {
    name: 'Nord Security',
    category: 'Privacy & Security',
    iconClass: 'fa-solid fa-shield-halved',
    iconColorClass: 'nord',
    tags: ['VPN', 'Password Manager', 'Encryption'],
    why: `When you're managing real money and connecting to exchanges, <strong>your security posture matters</strong>.
          Nord Security's suite protects your internet traffic with a VPN, secures your credentials with a password
          manager, and keeps your identity safe — tools worth having for any active trader or crypto user.`,
    products: [
      {
        name: 'NordVPN',
        description: 'Encrypt your internet traffic and hide your activity from ISPs and hackers — especially important on exchange connections.',
        link: 'https://go.nordvpn.net/aff_c?offer_id=15&aff_id=143568&url_id=902',
      },
      {
        name: 'NordPass',
        description: 'Store your exchange API keys and passwords in a zero-knowledge vault. Never reuse weak passwords again.',
        link: 'https://go.nordpass.io/aff_c?offer_id=488&aff_id=143568&url_id=9356',
      },
    ],
  },

  // ── Template — copy, fill in, and paste a real affiliate link ─────────────
  // New categories create their own section automatically; entries sharing a
  // category are grouped together in the order they appear here.
  // {
  //   name: 'Partner Name',
  //   category: 'Crypto Tax',
  //   iconClass: 'fa-solid fa-file-invoice-dollar',
  //   iconColorClass: 'example',      // add .partner-icon-example in affiliates.css
  //   tags: ['Tag One', 'Tag Two'],
  //   why: 'Why this matters for Cyrus users...',
  //   products: [
  //     { name: 'Product', description: 'Short description.', link: 'https://...', badge: 'Save 10%' },
  //   ],
  // },
];

class AffiliatesController {
  private root: HTMLElement | null = null;

  constructor() {
    this.root = document.getElementById('partner-sections');
    this.render();
  }

  private render(): void {
    if (!this.root) return;

    const empty = document.getElementById('partner-empty');
    if (AFFILIATES.length === 0) {
      this.root.innerHTML = '';
      empty?.classList.remove('d-none');
      return;
    }
    empty?.classList.add('d-none');

    // Group by category, preserving first-seen order so the list stays stable.
    const groups = new Map<string, Affiliate[]>();
    for (const a of AFFILIATES) {
      if (!groups.has(a.category)) groups.set(a.category, []);
      groups.get(a.category)!.push(a);
    }

    this.root.innerHTML = Array.from(groups.entries()).map(([category, items]) => `
      <section class="partner-section">
        <div class="partner-section-head">
          <h2 class="partner-section-title">${this.esc(category)}</h2>
          <span class="partner-section-count">${items.length} partner${items.length === 1 ? '' : 's'}</span>
        </div>
        <div class="partner-grid">${items.map(a => this.buildCard(a)).join('')}</div>
      </section>`).join('');
  }

  private buildCard(a: Affiliate): string {
    const tags = a.tags
      .map(t => `<span class="partner-tag">${this.esc(t)}</span>`)
      .join('');

    const products = a.products.map(p => `
      <li class="partner-product">
        <div class="partner-product-text">
          <span class="partner-product-name">${this.esc(p.name)}</span>
          <span class="partner-product-desc">${this.esc(p.description)}</span>
        </div>
        <a href="${this.esc(p.link)}" class="partner-product-cta" target="_blank" rel="noopener noreferrer">
          ${p.badge ? `<span class="partner-product-badge">${this.esc(p.badge)}</span>` : ''}
          <span>Get started</span>
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </a>
      </li>`).join('');

    return `
      <article class="partner-card">
        <header class="partner-card-head">
          <div class="partner-icon partner-icon-${this.esc(a.iconColorClass)}">
            <i class="${this.esc(a.iconClass)}"></i>
          </div>
          <div class="partner-card-meta">
            <h3 class="partner-card-name">${this.esc(a.name)}</h3>
            <span class="partner-card-category">${this.esc(a.category)}</span>
          </div>
        </header>

        <div class="partner-tags">${tags}</div>

        <p class="partner-why">${a.why}</p>

        <ul class="partner-products">${products}</ul>
      </article>`;
  }

  private esc(str: string): string {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
  }
}

new AffiliatesController();

})();
