// App entry point — register routes and load the initial page

(function () {
  // Register all routes
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

  router.register('home', {
    view: 'app/views/overview/home.html',
    viewModel: '../dist/app/viewmodels/overview/home.js',
    style: 'app/styles/overview/home.css',
    showChrome: true,
    title: 'Home',
  });

  // Placeholder routes — views will be built out later
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
    title: 'Custom Commands',
  });

  router.register('profile', {
    view: 'app/views/overview/profile.html',
    viewModel: '../dist/app/viewmodels/overview/profile.js',
    style: 'app/styles/overview/profile.css',
    showChrome: true,
    title: 'Profile',
  });

  // ---- Determine initial route ----
  if (AuthController.isAuthenticated()) {
    router.navigate('home');
  } else {
    router.navigate('login');
  }
})();
