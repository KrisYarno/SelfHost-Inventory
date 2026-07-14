import sgMail from '@sendgrid/mail';
import type { CombinedMinBreach, LocationMinBreach } from '@/types/inventory';

// Initialize SendGrid with API key
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface LowStockItem {
  productName: string;
  currentStock: number;
  threshold: number;
  daysUntilEmpty: number | null;
}

export interface LowStockEmailData {
  recipientName: string;
  items: LowStockItem[];
  unsubscribeToken?: string;
}

export interface MinimumDigestData {
  recipientName: string;
  locationItems: LocationMinBreach[];
  combinedItems: CombinedMinBreach[];
}

export interface WeeklyReportData {
  recipientName: string;
  dateRange: string;
  totalProducts: number;
  totalStock: number;
  lowStockCount: number;
  lowStockItems: Array<{
    name: string;
    currentStock: number;
    minimum: number;
    deficit: number;
  }>;
  topMovers: Array<{
    name: string;
    unitsMoved: number;
  }>;
  stockByLocation: Array<{
    name: string;
    totalStock: number;
  }>;
}

export class EmailService {
  private from = process.env.SENDGRID_FROM_EMAIL || 'alerts@advancedresearchpep.com';
  private templateId = process.env.TEMPLATE_ID;
  
  async sendEmail(options: EmailOptions): Promise<void> {
    if (!process.env.SENDGRID_API_KEY) {
      console.warn('SendGrid API key not configured, email not sent:', options.subject);
      return;
    }

    try {
      const msg = {
        from: this.from,
        to: options.to,
        subject: options.subject,
        text: options.text || '',
        html: options.html,
      };
      
      await sgMail.send(msg);
    } catch (error) {
      console.error('Error sending email:', error);
      throw new Error('Failed to send email');
    }
  }

  /**
   * S5: notify administrators that a pending user is awaiting approval. Returns a
   * discriminated result so callers can record a TRUTHFUL change-tracking event:
   *   - { attempted:false, sent:false } — SendGrid unconfigured or no admin recipients (skipped)
   *   - { attempted:true,  sent:true }  — dispatched to the provider
   *   - { attempted:true,  sent:false } — provider throw (caught here; caller stays honest)
   */
  async sendApprovalReminderEmail(
    to: string | string[],
    requestingUser: { email: string; username?: string | null }
  ): Promise<{ attempted: boolean; sent: boolean }> {
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!process.env.SENDGRID_API_KEY || recipients.length === 0) {
      console.warn(
        'SendGrid not configured (or no admin recipients); approval reminder not sent'
      );
      return { attempted: false, sent: false };
    }

    const name = requestingUser.username || requestingUser.email;
    const reviewUrl = process.env.NEXTAUTH_URL
      ? `${process.env.NEXTAUTH_URL}/admin/users`
      : null;
    const subject = 'Account approval reminder';
    const text = [
      `${name} (${requestingUser.email}) is waiting for account approval.`,
      reviewUrl ? `Review pending accounts: ${reviewUrl}` : 'Review pending accounts in the admin area.',
    ].join('\n\n');
    const html = `
      <p>${name} (${requestingUser.email}) is waiting for account approval.</p>
      <p>${reviewUrl ? `Review pending accounts at <a href="${reviewUrl}">${reviewUrl}</a>.` : 'Review pending accounts in the admin area.'}</p>
    `;

    try {
      await this.sendEmail({ to: recipients, subject, text, html });
      return { attempted: true, sent: true };
    } catch (error) {
      console.error('Failed to send approval reminder email:', error);
      return { attempted: true, sent: false };
    }
  }

  async sendMinimumsDigest(
    to: string | string[],
    data: MinimumDigestData
  ): Promise<void> {
    if (!process.env.SENDGRID_API_KEY) {
      console.warn('SendGrid API key not configured, minimum email not sent');
      return;
    }

    const subject = `Minimum Alert – ${data.locationItems.length + data.combinedItems.length} item(s)`;
    const html = this.generateMinimumsHTML(data);
    const text = this.generateMinimumsText(data);

    await this.sendEmail({
      to,
      subject,
      text,
      html,
    });
  }

  async sendLowStockDigest(
    to: string | string[],
    data: LowStockEmailData
  ): Promise<void> {
    if (!process.env.SENDGRID_API_KEY) {
      console.warn('SendGrid API key not configured, email not sent');
      return;
    }

    try {
      // Use dynamic template if available
      if (this.templateId) {
        // SendGrid dynamic templates don't use subject/text when templateId is provided
        const msg = {
          to,
          from: this.from, // Try simple string format
          templateId: this.templateId,
          dynamicTemplateData: {
            subject: `Low Stock Alert - ${data.items.length} Product${data.items.length > 1 ? 's' : ''} Need Attention`,
            recipientName: data.recipientName,
            items: data.items.map((item, index) => ({
              ...item,
              index: index + 1, // Add 1-based index
              daysUntilEmpty: item.daysUntilEmpty ?? 'N/A', // Handle null/undefined
            })),
            itemCount: data.items.length,
            itemCountPlural: data.items.length !== 1, // For plural handling
            date: new Date().toLocaleDateString(),
            inventoryUrl: `${process.env.NEXTAUTH_URL}/inventory`,
            unsubscribeUrl: data.unsubscribeToken 
              ? `${process.env.NEXTAUTH_URL}/unsubscribe?token=${data.unsubscribeToken}`
              : `${process.env.NEXTAUTH_URL}/account`,
          },
        };
        
        console.log('Sending email with template:', this.templateId);
        console.log('To:', to);
        console.log('Subject:', 'Low Stock Alert');
        
        const response = await sgMail.send(msg);
        console.log('SendGrid response:', response[0].statusCode);
      } else {
        // Fallback to inline HTML
        const subject = 'Daily Low Stock Alert - Action Required';
        const html = this.generateLowStockHTML(data);
        const text = this.generateLowStockText(data);
        
        await this.sendEmail({
          to,
          subject,
          text,
          html,
        });
      }
    } catch (error) {
      console.error('Error sending low stock digest:', error);
      
      // Log more detailed SendGrid error info
      if (error instanceof Error && 'response' in error && error.response) {
        const sgError = error as { response: { body: unknown } };
        console.error('SendGrid error response:', sgError.response.body);
      }
      
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private generateLowStockHTML(data: LowStockEmailData): string {
    const itemsHTML = data.items.map(item => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          <strong>${item.productName}</strong>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          ${item.currentStock}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          ${item.threshold}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          ${item.daysUntilEmpty ? `${item.daysUntilEmpty} days` : 'N/A'}
        </td>
      </tr>
    `).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Low Stock Alert</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f3f4f6;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: white; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <h1 style="color: #1f2937; margin-bottom: 24px;">Low Stock Alert</h1>
            
            <p style="color: #4b5563; margin-bottom: 24px;">
              Hi ${data.recipientName},
            </p>
            
            <p style="color: #4b5563; margin-bottom: 12px;">
              The following ${data.items.length} product${data.items.length > 1 ? 's are' : ' is'} at or below ${data.items.length > 1 ? 'their' : 'its'} alert threshold:
            </p>

            <p style="color: #6b7280; font-size: 13px; margin-bottom: 32px;">
              The alert threshold shown is each product's effective value — its own setting, or the system default where no custom threshold is set.
            </p>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 32px;">
              <thead>
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 12px; text-align: left; font-weight: 600; color: #374151;">Product</th>
                  <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151;">Current Stock</th>
                  <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151;">Alert threshold</th>
                  <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151;">Days Until Empty</th>
                </tr>
              </thead>
              <tbody>
                ${itemsHTML}
              </tbody>
            </table>
            
            <div style="text-align: center; margin-bottom: 32px;">
              <a href="${process.env.NEXTAUTH_URL}/inventory" 
                 style="display: inline-block; background-color: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
                View Inventory
              </a>
            </div>
            
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
            
            <p style="color: #6b7280; font-size: 14px; text-align: center;">
              You're receiving this email because you've opted into low stock alerts.
              ${data.unsubscribeToken ? `<br><a href="${process.env.NEXTAUTH_URL}/unsubscribe?token=${data.unsubscribeToken}" style="color: #3b82f6;">Unsubscribe</a>` : ''}
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private generateLowStockText(data: LowStockEmailData): string {
    const itemsList = data.items.map(item =>
      `- ${item.productName}: ${item.currentStock} units (alert threshold: ${item.threshold}, days until empty: ${item.daysUntilEmpty || 'N/A'})`
    ).join('\n');

    return `
Low Stock Alert

Hi ${data.recipientName},

The following ${data.items.length} product${data.items.length > 1 ? 's are' : ' is'} at or below ${data.items.length > 1 ? 'their' : 'its'} alert threshold:

${itemsList}

The alert threshold shown is each product's effective value — its own setting, or the system default where no custom threshold is set.

View inventory at: ${process.env.NEXTAUTH_URL}/inventory

You're receiving this email because you've opted into low stock alerts.
${data.unsubscribeToken ? `Unsubscribe: ${process.env.NEXTAUTH_URL}/unsubscribe?token=${data.unsubscribeToken}` : ''}
    `.trim();
  }

  private generateMinimumsHTML(data: MinimumDigestData): string {
    const locationRows = data.locationItems
      .map(
        (item) => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #1f2937;">${item.productName}</td>
          <td style="padding:8px;border-bottom:1px solid #1f2937;">${item.locationName}</td>
          <td style="padding:8px;border-bottom:1px solid #1f2937;text-align:center;">${item.currentQuantity}</td>
          <td style="padding:8px;border-bottom:1px solid #1f2937;text-align:center;">${item.minQuantity}</td>
        </tr>`
      )
      .join("");

    const combinedRows = data.combinedItems
      .map(
        (item) => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #1f2937;">${item.productName}</td>
          <td style="padding:8px;border-bottom:1px solid #1f2937;text-align:center;">${item.totalQuantity}</td>
          <td style="padding:8px;border-bottom:1px solid #1f2937;text-align:center;">${item.combinedMinimum}</td>
          <td style="padding:8px;border-bottom:1px solid #1f2937;text-align:center;">${item.daysUntilEmpty ?? "N/A"}</td>
        </tr>`
      )
      .join("");

    return `
      <h2 style="color:#e5e7eb;margin-bottom:16px;">Hello ${data.recipientName},</h2>
      <p style="color:#cbd5f5;">Here are the current minimum alerts.</p>
      ${
        locationRows
          ? `<h3 style="color:#fbbf24;margin-top:24px;">Location minimum breaches</h3>
             <table style="width:100%;border-collapse:collapse;color:#f9fafb;">
               <thead>
                 <tr>
                   <th align="left">Product</th>
                   <th align="left">Location</th>
                   <th>Current</th>
                   <th>Minimum</th>
                 </tr>
               </thead>
               <tbody>${locationRows}</tbody>
             </table>`
          : ""
      }
      ${
        combinedRows
          ? `<h3 style="color:#f87171;margin-top:24px;">Combined minimum breaches</h3>
             <table style="width:100%;border-collapse:collapse;color:#f9fafb;">
               <thead>
                 <tr>
                   <th align="left">Product</th>
                   <th>Total</th>
                   <th>Minimum</th>
                   <th>Days until empty</th>
                 </tr>
               </thead>
               <tbody>${combinedRows}</tbody>
             </table>`
          : ""
      }
      <p style="color:#9ca3af;margin-top:24px;">Manage notifications at ${process.env.NEXTAUTH_URL}/account</p>
    `;
  }

  private generateMinimumsText(data: MinimumDigestData): string {
    const loc = data.locationItems
      .map(
        (item) =>
          ` - ${item.productName} @ ${item.locationName}: ${item.currentQuantity}/${item.minQuantity}`
      )
      .join("\n");
    const combined = data.combinedItems
      .map(
        (item) =>
          ` - ${item.productName}: ${item.totalQuantity}/${item.combinedMinimum} (days until empty: ${
            item.daysUntilEmpty ?? "N/A"
          })`
      )
      .join("\n");

    return `
Minimum alerts for ${data.recipientName}

Location minimums:
${loc || "None"}

Combined minimums:
${combined || "None"}

Manage notifications: ${process.env.NEXTAUTH_URL}/account
    `.trim();
  }

  generateWeeklyReportHTML(data: WeeklyReportData): string {
    const appUrl = process.env.NEXTAUTH_URL || '';

    const lowStockRows = data.lowStockItems
      .map(
        (item) => `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color: #374151;">${item.name}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #374151;">${item.currentStock}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #374151;">${item.minimum}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #dc2626; font-weight: 600;">${item.deficit}</td>
        </tr>`
      )
      .join("");

    const topMoverRows = data.topMovers
      .map(
        (item) => `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color: #374151;">${item.name}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #374151;">${item.unitsMoved}</td>
        </tr>`
      )
      .join("");

    const locationRows = data.stockByLocation
      .map(
        (loc) => `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color: #374151;">${loc.name}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #374151;">${loc.totalStock}</td>
        </tr>`
      )
      .join("");

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Inventory Report</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background-color: #1e40af; padding: 24px 32px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700;">Weekly Inventory Report</h1>
              <p style="margin: 4px 0 0; color: #bfdbfe; font-size: 14px;">${data.dateRange}</p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 24px 32px 8px;">
              <p style="margin: 0; color: #4b5563; font-size: 15px;">Hi ${data.recipientName},</p>
              <p style="margin: 8px 0 0; color: #4b5563; font-size: 15px;">Here is your weekly inventory summary.</p>
            </td>
          </tr>

          <!-- Stats Row -->
          <tr>
            <td style="padding: 16px 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="33%" align="center" style="padding: 16px 8px; background-color: #eff6ff; border-radius: 8px;">
                    <p style="margin: 0; font-size: 28px; font-weight: 700; color: #1e40af;">${data.totalProducts}</p>
                    <p style="margin: 4px 0 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Products</p>
                  </td>
                  <td width="6"></td>
                  <td width="33%" align="center" style="padding: 16px 8px; background-color: #f0fdf4; border-radius: 8px;">
                    <p style="margin: 0; font-size: 28px; font-weight: 700; color: #16a34a;">${data.totalStock}</p>
                    <p style="margin: 4px 0 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Total Stock</p>
                  </td>
                  <td width="6"></td>
                  <td width="33%" align="center" style="padding: 16px 8px; background-color: ${data.lowStockCount > 0 ? '#fef2f2' : '#f0fdf4'}; border-radius: 8px;">
                    <p style="margin: 0; font-size: 28px; font-weight: 700; color: ${data.lowStockCount > 0 ? '#dc2626' : '#16a34a'};">${data.lowStockCount}</p>
                    <p style="margin: 4px 0 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Low Stock</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${
            data.lowStockItems.length > 0
              ? `
          <!-- Low Stock Section -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #dc2626;">Products Below Minimums</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Product</th>
                  <th style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Stock</th>
                  <th style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Minimum</th>
                  <th style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Deficit</th>
                </tr>
                ${lowStockRows}
              </table>
            </td>
          </tr>`
              : ""
          }

          ${
            data.topMovers.length > 0
              ? `
          <!-- Top Movers Section -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #374151;">Top 10 Movers This Week</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Product</th>
                  <th style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Units Moved</th>
                </tr>
                ${topMoverRows}
              </table>
            </td>
          </tr>`
              : ""
          }

          ${
            data.stockByLocation.length > 0
              ? `
          <!-- Location Summary Section -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #374151;">Stock by Location</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Location</th>
                  <th style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Total Stock</th>
                </tr>
                ${locationRows}
              </table>
            </td>
          </tr>`
              : ""
          }

          <!-- CTA Button -->
          <tr>
            <td align="center" style="padding: 0 32px 32px;">
              <a href="${appUrl}/dashboard"
                 style="display: inline-block; background-color: #1e40af; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
                View Dashboard
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px; text-align: center;">
                You are receiving this email because you opted into email alerts.
                <br>
                <a href="${appUrl}/account" style="color: #3b82f6; text-decoration: underline;">Manage notification preferences</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  generateWeeklyReportText(data: WeeklyReportData): string {
    const appUrl = process.env.NEXTAUTH_URL || '';

    const lowStockList = data.lowStockItems.length > 0
      ? data.lowStockItems
          .map(
            (item) =>
              `  - ${item.name}: ${item.currentStock} in stock (minimum: ${item.minimum}, deficit: ${item.deficit})`
          )
          .join("\n")
      : "  None";

    const moversList = data.topMovers.length > 0
      ? data.topMovers
          .map((item) => `  - ${item.name}: ${item.unitsMoved} units moved`)
          .join("\n")
      : "  No activity";

    const locationList = data.stockByLocation.length > 0
      ? data.stockByLocation
          .map((loc) => `  - ${loc.name}: ${loc.totalStock} units`)
          .join("\n")
      : "  No locations";

    return `
Weekly Inventory Report — ${data.dateRange}

Hi ${data.recipientName},

Summary:
  Total Products: ${data.totalProducts}
  Total Stock: ${data.totalStock}
  Low Stock Alerts: ${data.lowStockCount}

Products Below Minimums:
${lowStockList}

Top 10 Movers This Week:
${moversList}

Stock by Location:
${locationList}

View dashboard: ${appUrl}/dashboard

Manage notification preferences: ${appUrl}/account
    `.trim();
  }
}

// Export singleton instance
export const emailService = new EmailService();
