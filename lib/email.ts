import sgMail from '@sendgrid/mail';

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
        // Generate plain text version
        const plainText = this.generateLowStockText(data);
        
        // SendGrid dynamic templates don't use subject/text when templateId is provided
        const msg: any = {
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
        console.log('Subject:', msg.subject);
        
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
    } catch (error: any) {
      console.error('Error sending low stock digest:', error);
      
      // Log more detailed SendGrid error info
      if (error.response) {
        console.error('SendGrid error response:', error.response.body);
      }
      
      throw new Error(`Failed to send email: ${error.message || 'Unknown error'}`);
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
}

// Export singleton instance
export const emailService = new EmailService();