/**
 * Unwrapping layer over TaxData. Viewmodels call this, never TaxData directly —
 * it is also the seam demo mode patches.
 */
class TaxController {
  /** localStorage key for the chosen lot method, shared with Limit Orders. */
  private static readonly METHOD_KEY = 'cyrus_cost_basis_method';

  /** The lot method the user last picked on the Taxes page (FIFO by default). */
  static getPreferredMethod(): CostBasisMethod {
    try {
      return localStorage.getItem(TaxController.METHOD_KEY) === 'hifo' ? 'hifo' : 'fifo';
    } catch {
      return 'fifo';
    }
  }

  static setPreferredMethod(method: CostBasisMethod): void {
    try { localStorage.setItem(TaxController.METHOD_KEY, method); } catch { /* convenience only */ }
  }

  private static token(): string {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    return token;
  }

  static async getStatus(): Promise<TaxSyncStatus> {
    return (await TaxData.status(TaxController.token())).data;
  }

  /** One bounded slice of trade sync. `complete: false` means call again. */
  static async sync(connId?: number | 'all'): Promise<TaxSyncResult> {
    return (await TaxData.sync(TaxController.token(), connId)).data;
  }

  static async getGains(method: CostBasisMethod, year?: number,
                        needsInfoOnly = false): Promise<TaxGains> {
    return (await TaxData.gains(TaxController.token(), method, year, needsInfoOnly)).data;
  }

  static async getManual(): Promise<ManualCostBasis> {
    return (await TaxData.manual(TaxController.token())).data;
  }

  static async addLot(lot: ManualLotInput): Promise<number> {
    return (await TaxData.addLot(TaxController.token(), lot)).data.id;
  }

  static async deleteLot(id: number): Promise<void> {
    await TaxData.deleteLot(TaxController.token(), id);
  }

  static async setDepositCost(transferId: number, body: DepositCostInput): Promise<void> {
    await TaxData.setDepositCost(TaxController.token(), transferId, body);
  }

  static async deleteDepositCost(transferId: number): Promise<void> {
    await TaxData.deleteDepositCost(TaxController.token(), transferId);
  }

  static async setTradePrice(tradeId: number, quoteUsdPrice: number): Promise<void> {
    await TaxData.setTradePrice(TaxController.token(), tradeId, quoteUsdPrice);
  }

  static async deleteTradePrice(tradeId: number): Promise<void> {
    await TaxData.deleteTradePrice(TaxController.token(), tradeId);
  }

  static async exportFile(format: TaxExportFormat, method: CostBasisMethod,
                          year?: number): Promise<TaxExportFile> {
    return (await TaxData.exportFile(TaxController.token(), format, method, year)).data;
  }

  static async projectSells(method: CostBasisMethod,
                            sells: ProjectedSellInput[]): Promise<ProjectedSells> {
    return (await TaxData.projectSells(TaxController.token(), method, sells)).data;
  }
}
