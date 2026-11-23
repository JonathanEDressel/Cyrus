class NotificationService {
  private static readonly POLL_INTERVAL = 30000; // 30 seconds
  private static timer: number | null = null;
  private static lastSeenLogId: number = 0;
  private static isRunning: boolean = false;
  private static notificationsEnabled: boolean = true;
  /** Fired chart alerts are reported once each, from when the app started. */
  private static alertsSince: number = 0;

  static setEnabled(enabled: boolean): void {
    NotificationService.notificationsEnabled = enabled;
  }

  static get isEnabled(): boolean {
    return NotificationService.notificationsEnabled;
  }

  static async start(): Promise<void> {
    if (NotificationService.isRunning) return;

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    NotificationService.isRunning = true;
    NotificationService.alertsSince = Math.floor(Date.now() / 1000);
    // Alerts on custom indicators are watched from here (the backend can't run Pine).
    if (typeof ScriptAlertMonitor !== 'undefined') ScriptAlertMonitor.start();
    NotificationService.pollLogs();
    NotificationService.timer = window.setInterval(
      () => { NotificationService.pollLogs(); NotificationService.pollAlerts(); },
      NotificationService.POLL_INTERVAL
    );
  }

  static stop(): void {
    if (NotificationService.timer !== null) {
      window.clearInterval(NotificationService.timer);
      NotificationService.timer = null;
    }
    NotificationService.isRunning = false;
    NotificationService.lastSeenLogId = 0;
    if (typeof ScriptAlertMonitor !== 'undefined') ScriptAlertMonitor.stop();
  }

  private static async pollLogs(): Promise<void> {
    if (!NotificationService.notificationsEnabled) return;
    try {
      const logs = await AutomationController.getLogs(10);
      
      if (logs.length === 0) return;

      // Initialize with the most recent log ID on first poll
      if (NotificationService.lastSeenLogId === 0) {
        NotificationService.lastSeenLogId = Math.max(...logs.map(l => l.id));
        return;
      }

      // Find new logs (newer than lastSeenLogId)
      const newLogs = logs.filter(l => l.id > NotificationService.lastSeenLogId);
      
      if (newLogs.length === 0) return;

      // Update lastSeenLogId
      NotificationService.lastSeenLogId = Math.max(...logs.map(l => l.id));

      // Show notification for each new log
      for (const log of newLogs) {
        NotificationService.showNotification(log);
      }
    } catch (error) {
      console.error('[NotificationService] Error polling logs:', error);
    }
  }

  /** Price alerts set on the Charts page that fired since the last look. */
  private static async pollAlerts(): Promise<void> {
    if (!NotificationService.notificationsEnabled) return;
    try {
      const fired = (await AlertData.events(NotificationService.alertsSince)).data || [];
      if (!fired.length) return;
      NotificationService.alertsSince = Math.max(NotificationService.alertsSince, ...fired.map((a) => a.triggered_at || 0));
      void ChartAlerts.refresh();
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      for (const a of fired) {
        const n = new Notification(`🔔 ${a.symbol} ${ChartAlerts.describe(a)}`, {
          body: a.note || `Your chart alert on ${a.symbol} fired. It's now off until you move the line or re-arm it.`,
          silent: false,
        });
        setTimeout(() => n.close(), 15000);
        n.onclick = () => {
          if (typeof router !== 'undefined') {
            void router.navigate('charts', a.chart_id ? { chartId: String(a.chart_id) } : undefined);
          }
          n.close();
        };
      }
    } catch (error) {
      console.error('[NotificationService] Error polling alerts:', error);
    }
  }

  private static showNotification(log: any): void {
    if ('Notification' in window && Notification.permission === 'granted') {
      const isSuccess = log.status === 'success';
      const icon = isSuccess ? '✅' : '❌';
      const title = `${icon} Automation Rule ${isSuccess ? 'Executed' : 'Failed'}`;
      
      const body = `${log.action_executed}\n${log.action_result}`;

      const notification = new Notification(title, {
        body: body,
        icon: undefined, // Could add app icon path here if available
        silent: false,
        requireInteraction: false,
      });

      // Close notification after 10 seconds
      setTimeout(() => notification.close(), 10000);

      // Optional: Click to navigate to commands page
      notification.onclick = () => {
        if (typeof router !== 'undefined') {
          router.navigate('commands');
        }
        notification.close();
      };
    }
  }
}
