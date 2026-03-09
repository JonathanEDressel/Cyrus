interface RouteConfig {
  /** Path to the HTML partial relative to src/ (e.g. "app/views/login.html") */
  view: string;
  /** Path to the compiled viewmodel JS relative to dist/ (e.g. "app/viewmodels/login.js") */
  viewModel: string;
  /** Optional CSS file to load (relative to src/) */
  style?: string;
  /** Whether header/footer should be visible on this route */
  showChrome: boolean;
  /** Page title suffix */
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

  /** Register a named route */
  register(name: string, config: RouteConfig): void {
    this.routes[name] = config;
  }

  /** Navigate to a named route, optionally passing query-string params */
  async navigate(name: string, params?: Record<string, string>): Promise<void> {
    const route = this.routes[name];
    if (!route) {
      console.error(`Route "${name}" not found`);
      return;
    }

    this.currentRoute = name;

    // Update title
    document.title = `Kraking - ${route.title}`;

    // Show / hide header + footer
    const header = document.getElementById('app-header');
    const footer = document.getElementById('app-footer');
    if (route.showChrome) {
      header?.classList.remove('d-none');
      footer?.classList.remove('d-none');
      this.updateActiveNav(name);
    } else {
      header?.classList.add('d-none');
      footer?.classList.add('d-none');
    }

    // Load optional page-specific stylesheet
    if (route.style) {
      this.loadStyle(route.style);
    }

    // Fetch and inject HTML partial
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

    // Load viewmodel script (re-load each time so constructor re-runs)
    this.loadScript(route.viewModel, params);
  }

  /** Get the current route name */
  getCurrentRoute(): string {
    return this.currentRoute;
  }

  // ---- Private helpers ----

  /** Wire up click handlers on all [data-route] links in header/footer */
  private setupNavListeners(): void {
    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-route]') as HTMLElement | null;
      if (target) {
        e.preventDefault();
        const routeName = target.getAttribute('data-route');
        if (routeName) this.navigate(routeName);
      }
    });

    // Logout button
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      AuthController.logout();
      this.navigate('login');
    });
  }

  /** Highlight the active nav link */
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
  }

  private loadScript(src: string, params?: Record<string, string>): void {
    // Remove previously loaded viewmodel script so the new one executes fresh
    const existing = document.getElementById('viewmodel-script');
    if (existing) existing.remove();

    // Stash params so the viewmodel can read them
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
