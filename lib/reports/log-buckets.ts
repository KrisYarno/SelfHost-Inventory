// P-C6: the shared "adjustments-like" ledger bucket. The four reports consumers
// (daily-activity, date-details, user-activity, user-details) count these logTypes
// as adjustments/corrections. STOCK_IN and SALE are FLOW (received / sold), not
// correction, and never count here. One constant, four consumers, greppable —
// so a new CORRECTION/COUNT row can never silently undercount the metric that
// reports it. (Read-path lanes import this; the trunk only declares it.)
export const ADJUSTMENT_LIKE = ["ADJUSTMENT", "CORRECTION", "COUNT"] as const;
