import { FailedUpdate, MassUpdateChange, RecoveryState } from '@/types/mass-update-errors';

const RECOVERY_STORAGE_KEY = 'mass_update_recovery';
const MAX_RETRY_ATTEMPTS = 3;
const RECOVERY_STATE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export class MassUpdateRecoveryManager {
  private state: RecoveryState | null = null;

  constructor() {
    this.loadRecoveryState();
  }

  /**
   * Load recovery state from localStorage
   */
  private loadRecoveryState(): void {
    if (typeof window === 'undefined') return;

    try {
      const saved = localStorage.getItem(RECOVERY_STORAGE_KEY);
      if (!saved) return;

      const state = JSON.parse(saved) as RecoveryState;
      
      // Check if state is expired
      const age = Date.now() - new Date(state.lastAttempt).getTime();
      if (age > RECOVERY_STATE_TTL) {
        this.clearRecoveryState();
        return;
      }

      // Deserialize dates
      state.lastAttempt = new Date(state.lastAttempt);
      state.failedUpdates = state.failedUpdates.map(failure => ({
        ...failure,
        timestamp: new Date(failure.timestamp)
      }));

      this.state = state;
    } catch (error) {
      console.error('Failed to load recovery state:', error);
      this.clearRecoveryState();
    }
  }

  /**
   * Save recovery state to localStorage
   */
  private saveRecoveryState(): void {
    if (typeof window === 'undefined' || !this.state) return;

    try {
      localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(this.state));
    } catch (error) {
      console.error('Failed to save recovery state:', error);
    }
  }

  /**
   * Clear recovery state
   */
  clearRecoveryState(): void {
    this.state = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(RECOVERY_STORAGE_KEY);
    }
  }

  /**
   * Check if there are recoverable failures
   */
  hasRecoverableFailures(): boolean {
    return !!this.state && this.state.failedUpdates.length > 0;
  }

  /**
   * Get current recovery state
   */
  getRecoveryState(): RecoveryState | null {
    return this.state;
  }

  /**
   * Save failed updates for recovery
   */
  saveFailedUpdates(failures: FailedUpdate[]): void {
    const retryableFailures = failures.filter(f => f.canRetry);
    
    if (retryableFailures.length === 0) {
      this.clearRecoveryState();
      return;
    }

    this.state = {
      failedUpdates: retryableFailures,
      lastAttempt: new Date(),
      retryCount: (this.state?.retryCount || 0) + 1,
      isRecovering: false
    };

    this.saveRecoveryState();
  }

  /**
   * Mark recovery as in progress
   */
  startRecovery(): void {
    if (!this.state) return;
    
    this.state.isRecovering = true;
    this.saveRecoveryState();
  }

  /**
   * Update recovery state after retry
   */
  updateAfterRetry(remainingFailures: FailedUpdate[]): void {
    if (remainingFailures.length === 0) {
      this.clearRecoveryState();
      return;
    }

    this.state = {
      failedUpdates: remainingFailures,
      lastAttempt: new Date(),
      retryCount: (this.state?.retryCount || 0) + 1,
      isRecovering: false
    };

    // Clear if max retries exceeded
    if (this.state.retryCount >= MAX_RETRY_ATTEMPTS) {
      this.clearRecoveryState();
      return;
    }

    this.saveRecoveryState();
  }

  /**
   * Convert failed updates back to changes for retry
   */
  getRetryChanges(): MassUpdateChange[] {
    if (!this.state) return [];

    return this.state.failedUpdates.map(failure => ({
      productId: failure.productId,
      locationId: failure.locationId,
      newQuantity: failure.attemptedQuantity,
      delta: failure.attemptedQuantity - failure.currentQuantity,
      productName: failure.productName,
      locationName: failure.locationName
    }));
  }

  /**
   * Check if recovery can be attempted
   */
  canRetry(): boolean {
    if (!this.state) return false;
    return this.state.retryCount < MAX_RETRY_ATTEMPTS && !this.state.isRecovering;
  }
}

// Singleton instance
export const recoveryManager = new MassUpdateRecoveryManager();