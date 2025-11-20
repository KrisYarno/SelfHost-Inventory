import type { CombinedMinBreach, LocationMinBreach } from "@/types/inventory";

interface MinimumsSummaryPayload {
  locationItems: LocationMinBreach[];
  combinedItems: CombinedMinBreach[];
}

class SmsService {
  async sendMinimumsSummary(
    phoneNumber: string,
    data: MinimumsSummaryPayload
  ): Promise<void> {
    if (!process.env.SMS_ENABLED) {
      console.warn(
        "SMS not enabled. Skipping minimum summary sms to",
        phoneNumber
      );
      return;
    }

    const messageLines: string[] = [];

    if (data.locationItems.length) {
      messageLines.push("Location minimums:");
      for (const item of data.locationItems) {
        messageLines.push(
          `• ${item.productName}@${item.locationName}: ${item.currentQuantity}/${item.minQuantity}`
        );
      }
    }

    if (data.combinedItems.length) {
      messageLines.push("Combined minimums:");
      for (const item of data.combinedItems) {
        messageLines.push(
          `• ${item.productName}: ${item.totalQuantity}/${item.combinedMinimum}`
        );
      }
    }

    const body = messageLines.join("\n") || "Minimum summary (no items).";

    // TODO: integrate SMS provider (e.g., Twilio)
    console.log(`SMS to ${phoneNumber}:\n${body}`);
  }
}

export const smsService = new SmsService();
