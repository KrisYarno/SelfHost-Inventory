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
            
            <p style="color: #4b5563; margin-bottom: 32px;">
              The following ${data.items.length} product${data.items.length > 1 ? 's are' : ' is'} running low on stock:
            </p>
            
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 32px;">
              <thead>
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 12px; text-align: left; font-weight: 600; color: #374151;">Product</th>
                  <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151;">Current Stock</th>
                  <th style="padding: 12px; text-align: center; font-weight: 600; color: #374151;">Threshold</th>
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
      `- ${item.productName}: ${item.currentStock} units (threshold: ${item.threshold}, days until empty: ${item.daysUntilEmpty || 'N/A'})`
    ).join('\n');

    return `
Low Stock Alert

Hi ${data.recipientName},

The following ${data.items.length} product${data.items.length > 1 ? 's are' : ' is'} running low on stock:

${itemsList}

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
}

// Export singleton instance
export const emailService = new EmailService();
