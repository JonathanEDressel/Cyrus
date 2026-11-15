interface RouteConfig {
  view: string;
  viewModel: string;
  /** One stylesheet, or several loaded in order (later files win). */
  style?: string | string[];
  showChrome: boolean;
  showExchangeSelector?: boolean;
  title: string;
}

class Router {
  private routes: Record<string, RouteConfig> = {};
  private currentRoute: string = '';
  private contentEl: HTMLElement | null = null;
  private loadedStyles: Set<string> = new Set();
  private loadedScripts: Set<string> = new Set();

  constructor() {
    this.contentEl = document.getElementById('app-content');
    this.setupNavListeners();
  }

  register(name: string, config: RouteConfig): void {
    this.routes[name] = config;
  }

  async navigate(name: string, params?: Record<string, string>): Promise<void> {
    const route = this.routes[name];
    if (!route) {
      console.error(`Route "${name}" not found`);
      return;
    }

    this.currentRoute = name;

    document.title = `Cyrus - ${route.title}`;

    const header = document.getElementById('app-header');
    const footer = document.getElementById('app-footer');
    const exchangeSelectorWrapper = document.getElementById('exchange-selector-wrapper');
    // The assistant launcher rides with the rest of the chrome: it has nothing
    // to talk about on the login and create-account screens.
    const aiLauncher = document.getElementById('ai-fab-wrap');
    if (route.showChrome) {
      header?.classList.remove('d-none');
      footer?.classList.remove('d-none');
      aiLauncher?.classList.remove('d-none');
      this.updateActiveNav(name);
      if (typeof TopBar !== 'undefined') TopBar.onChromeShown();
    } else {
      header?.classList.add('d-none');
      footer?.classList.add('d-none');
      aiLauncher?.classList.add('d-none');
    }
    if (exchangeSelectorWrapper) {
      if (route.showExchangeSelector === false || !route.showChrome) {
        exchangeSelectorWrapper.classList.add('d-none');
      } else {
        exchangeSelectorWrapper.classList.remove('d-none');
      }
    }

    if (route.style) {
      // Styles are additive and never unloaded, so a route that reuses another
      // page's stylesheet just lists it here instead of duplicating the rules.
      const styles = Array.isArray(route.style) ? route.style : [route.style];
      styles.forEach(href => this.loadStyle(href));
    }

    try {
      const response = await fetch(route.view);
      if (!response.ok) throw new Error(`Failed to load view: ${route.view}`);
      const html = await response.text();

      if (this.contentEl) {
        this.contentEl.innerHTML = html;
      }
    } catch (err) {
      console.error('Router: failed to load view', err);
      if (this.contentEl) {
        this.contentEl.innerHTML = '<p style="color:#fff;text-align:center;margin-top:4rem;">Failed to load page.</p>';
      }
      return;
    }

    this.loadScript(route.viewModel, params);
  }

  getCurrentRoute(): string {
    return this.currentRoute;
  }

  private setupNavListeners(): void {
    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-route]') as HTMLElement | null;
      if (target) {
        e.preventDefault();
        const routeName = target.getAttribute('data-route');
        if (routeName) this.navigate(routeName);
      }
    });

    document.getElementById('logout-btn')?.addEventListener('click', () => {
      // A ladder or bulk cancel runs in the background; logging out ends it.
      if (OrderJobRunner.isBusy()) {
        const job = OrderJobRunner.current();
        const what = job?.kind === 'cancel' ? 'cancelled' : 'placed';
        if (!window.confirm(`Orders are still being ${what}. Logging out stops the rest — `
            + 'anything not yet sent is never sent. Log out anyway?')) {
          return;
        }
      }
      AuthController.logout();
      this.navigate('login');
    });
  }

  private updateActiveNav(routeName: string): void {
    const navLinks = document.querySelectorAll('#header-nav .nav-link');
    navLinks.forEach(link => {
      const linkRoute = link.getAttribute('data-route');
      if (linkRoute === routeName) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  private loadStyle(href: string): void {
    if (this.loadedStyles.has(href)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    this.loadedStyles.add(href);
    // The Terminal design layer restyles every page, so it must stay after
    // each page stylesheet in the cascade. Moving the <link> doesn't reload it.
    const terminal = document.getElementById('terminal-css');
    if (terminal) document.head.appendChild(terminal);
  }

  private loadScript(src: string, params?: Record<string, string>): void {
    const existing = document.getElementById('viewmodel-script');
    if (existing) existing.remove();

    if (params) {
      (window as any).__routeParams = params;
    } else {
      delete (window as any).__routeParams;
    }

    const script = document.createElement('script');
    script.id = 'viewmodel-script';
    script.src = src;
    document.body.appendChild(script);
  }
}

// Single global router instance
const router = new Router();
