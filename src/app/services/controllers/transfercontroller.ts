/**
 * Unwrapping layer over TransferData. Viewmodels call this, never TransferData
 * directly — it is also the seam demo mode patches.
 */
class TransferController {
  static async getTransfers(filters: TransferFilters = {}): Promise<TransferPage> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await TransferData.list(token, filters);
    return response.data;
  }

  static async getStatus(): Promise<TransferSyncStatus> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await TransferData.status(token);
    return response.data;
  }

  /**
   * Run one bounded slice of sync. `complete: false` means there is more
   * history to pull, not that anything went wrong — call again.
   */
  static async sync(connId?: number | 'all'): Promise<TransferSyncResult> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await TransferData.sync(token, connId);
    return response.data;
  }

  static async getAssets(): Promise<string[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await TransferData.assets(token);
    return response.data;
  }
}
