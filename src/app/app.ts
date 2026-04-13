(function () {
  router.register('login', {
    view: 'app/views/login.html',
    viewModel: '../dist/app/viewmodels/login.js',
    style: 'app/styles/login.css',
    showChrome: false,
    title: 'Login',
  });

  router.register('createaccount', {
    view: 'app/views/createaccount.html',
    viewModel: '../dist/app/viewmodels/createaccount.js',
    style: 'app/styles/login.css',
    showChrome: false,
    title: 'Create Account',
  });

  router.register('accounts', {
    view: 'app/views/accounts.html',
    viewModel: '../dist/app/viewmodels/accounts.js',
    style: 'app/styles/login.css',
    showChrome: false,
    title: 'All Accounts',
  });

  router.register('home', {
    view: 'app/views/overview/home.html',
    viewModel: '../dist/app/viewmodels/overview/home.js',
    style: 'app/styles/overview/home.css',
    showChrome: true,
    title: 'Home',
  });

  router.register('positions', {
    view: 'app/views/overview/home.html',
    viewModel: '../dist/app/viewmodels/overview/home.js',
    style: 'app/styles/overview/home.css',
    showChrome: true,
    title: 'Positions',
  });

  router.register('openorders', {
    view: 'app/views/overview/openorders.html',
    viewModel: '../dist/app/viewmodels/overview/openorders.js',
    style: 'app/styles/overview/openorders.css',
    showChrome: true,
    title: 'Open Orders',
  });

  router.register('whitelist', {
    view: 'app/views/overview/whitelist.html',
    viewModel: '../dist/app/viewmodels/overview/whitelist.js',
    style: 'app/styles/overview/whitelist.css',
    showChrome: true,
    title: 'Whitelisted Addresses',
  });

  router.register('commands', {
    view: 'app/views/overview/commands.html',
    viewModel: '../dist/app/viewmodels/overview/commands.js',
    style: 'app/styles/overview/commands.css',
    showChrome: true,
    showExchangeSelector: false,
    title: 'Custom Commands',
  });

  router.register('profile', {
    view: 'app/views/overview/profile.html',
    viewModel: '../dist/app/viewmodels/overview/profile.js',
    style: 'app/styles/overview/profile.css',
    showChrome: true,
    showExchangeSelector: false,
    title: 'Profile',
  });

  router.register('privacy', {
    view: 'app/views/overview/privacy.html',
    viewModel: '../dist/app/viewmodels/overview/privacy.js',
    style: 'app/styles/overview/privacy.css',
    showChrome: true,
    showExchangeSelector: false,
    title: 'Privacy',
  });

  router.register('about', {
    view: 'app/views/overview/about.html',
    viewModel: '../dist/app/viewmodels/overview/about.js',
    style: 'app/styles/overview/about.css',
    showChrome: true,
    showExchangeSelector: false,
    title: 'About',
  });

  if (AuthController.isAuthenticated()) {
    // Verify the token is still valid before navigating to protected routes
    const tokenValid = await UserController.verifyToken();
    if (!tokenValid) {
      router.navigate('login');
    } else {
    ApiKeyWarning.init();
    UserController.refreshKeyStatus().then(async () => {
      if (ApiKeyState.status === 'valid') {
        try {
          await ExchangeStore.loadConnections();
          populateExchangeSelector();
          const saved = localStorage.getItem('cyrus_exchange_mode');
          if (saved && saved !== 'all') {
            const id = parseInt(saved, 10);
            const valid = ExchangeStore.connections.find(c => c.id === id);
            if (valid) {
              ExchangeStore.start(id);
              setExchangeSelectorValue(saved);
            } else {
              ExchangeStore.start('all');
            }
          } else if (ExchangeStore.connections.length > 0) {
            ExchangeStore.start('all');
          }
        } catch {}
        NotificationService.start();
      }
    });

    ExchangeStore.onConnectionsChange(() => populateExchangeSelector());

    const selector = document.getElementById('exchange-selector') as HTMLSelectElement;
    selector?.addEventListener('change', () => {
      const val = selector.value;
      localStorage.setItem('cyrus_exchange_mode', val);
      if (val === 'all') {
        ExchangeStore.setMode('all');
      } else {
        ExchangeStore.setMode(parseInt(val, 10));
      }
    });

    router.navigate('home');
    }
  } else {
    router.navigate('login');
  }

  function populateExchangeSelector(): void {
    const selector = document.getElementById('exchange-selector') as HTMLSelectElement;
    if (!selector) return;
    const currentValue = selector.value;
    selector.innerHTML = '<option value="all">All Exchanges</option>';
    for (const conn of ExchangeStore.connections) {
      const opt = document.createElement('option');
      opt.value = conn.id.toString();
      const label = conn.label && conn.label !== 'Default' ? conn.label : conn.exchange_name;
      opt.textContent = label;
      selector.appendChild(opt);
    }
    if (currentValue && Array.from(selector.options).some(o => o.value === currentValue)) {
      selector.value = currentValue;
    }
  }

  function setExchangeSelectorValue(val: string): void {
    const selector = document.getElementById('exchange-selector') as HTMLSelectElement;
    if (selector) selector.value = val;
  }
})();
