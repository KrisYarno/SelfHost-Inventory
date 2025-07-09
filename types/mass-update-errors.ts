// Mass Update Error Types
export type UpdateFailureReason = 
  | 'VALIDATION_ERROR'
  | 'INSUFFICIENT_STOCK' 
  | 'PRODUCT_NOT_FOUND'
  | 'LOCATION_NOT_FOUND'
  | 'CONCURRENT_UPDATE'
  | 'DATABASE_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface FailedUpdate {
  productId: number;
  productName: string;
  locationId: number;
  locationName: string;
  attemptedQuantity: number;
  currentQuantity: number;
  reason: UpdateFailureReason;
  message: string;
  timestamp: Date;
  canRetry: boolean;
}

export interface BatchUpdateResult {
  successful: number;
  failed: number;
  partial: boolean;
  failures: FailedUpdate[];
  transactionId?: string;
}

export interface MassUpdateChange {
  productId: number;
  locationId: number;
  newQuantity: number;
  delta: number;
  productName?: string;
  locationName?: string;
}

export interface RecoveryState {
  failedUpdates: FailedUpdate[];
  lastAttempt: Date;
  retryCount: number;
  isRecovering: boolean;
}

export class MassUpdateError extends Error {
  constructor(
    message: string,
    public reason: UpdateFailureReason,
    public failures: FailedUpdate[],
    public partialSuccess: boolean = false
  ) {
    super(message);
    this.name = 'MassUpdateError';
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public value: any
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Pagination types for mass update
export interface PaginationMetadata {
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface MassUpdateProductLocation {
  locationId: number;
  locationName: string;
  currentQuantity: number;
  newQuantity: number | null;
  delta: number;
  hasChanged: boolean;
}

export interface MassUpdateProduct {
  productId: number;
  productName: string;
  baseName: string;
  variant: string | null;
  locations: MassUpdateProductLocation[];
}

export interface MassUpdateLocation {
  id: number;
  name: string;
}

export interface MassUpdateResponse {
  products: MassUpdateProduct[];
  locations: MassUpdateLocation[];
  totalProducts: number;
  totalChanges: number;
}

export interface PaginatedMassUpdateResponse extends MassUpdateResponse {
  pagination?: PaginationMetadata;
}