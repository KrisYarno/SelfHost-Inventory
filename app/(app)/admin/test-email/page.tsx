'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Mail, CheckCircle2, AlertCircle } from 'lucide-react';

export default function TestEmailPage() {
  const [isSending, setIsSending] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; message?: string; details?: any } | null>(null);

  const sendTestEmail = async () => {
    setIsSending(true);
    setResult(null);
    
    try {
      const response = await fetch('/api/test/email', {
        method: 'POST',
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setResult({
          success: true,
          message: data.message,
          details: data,
        });
      } else {
        setResult({
          success: false,
          message: data.error || 'Failed to send test email',
          details: data.details,
        });
      }
    } catch (error) {
      setResult({
        success: false,
        message: 'Network error occurred',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsSending(false);
    }
  };

  const runStockCheck = async () => {
    setIsSending(true);
    setResult(null);
    
    try {
      const response = await fetch('/api/cron/stock-check');
      const data = await response.json();
      
      if (response.ok) {
        setResult({
          success: true,
          message: `Stock check completed. Found ${data.lowStockCount} low stock items.`,
          details: data,
        });
      } else {
        setResult({
          success: false,
          message: data.error || 'Stock check failed',
          details: data.details,
        });
      }
    } catch (error) {
      setResult({
        success: false,
        message: 'Network error occurred',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <h1 className="text-3xl font-bold mb-6">Email Testing</h1>
      
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Test Low Stock Email
            </CardTitle>
            <CardDescription>
              Send a test low stock alert email to your admin email address
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground space-y-2">
              <p>This will send a test email with sample data to verify:</p>
              <ul className="list-disc list-inside space-y-1 ml-4">
                <li>SendGrid API key is valid</li>
                <li>Template ID is configured correctly</li>
                <li>Email formatting looks good</li>
              </ul>
            </div>
            
            <Button
              onClick={sendTestEmail}
              disabled={isSending}
              className="w-full"
            >
              {isSending ? 'Sending...' : 'Send Test Email'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5" />
              Run Stock Check
            </CardTitle>
            <CardDescription>
              Manually trigger the daily stock check process
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground space-y-2">
              <p>This will:</p>
              <ul className="list-disc list-inside space-y-1 ml-4">
                <li>Check all products against their thresholds</li>
                <li>Send emails to users who opted in</li>
                <li>Use real data from your inventory</li>
              </ul>
            </div>
            
            <Button
              onClick={runStockCheck}
              disabled={isSending}
              variant="outline"
              className="w-full"
            >
              {isSending ? 'Running...' : 'Run Stock Check Now'}
            </Button>
          </CardContent>
        </Card>

        {result && (
          <Alert className={result.success ? 'border-success' : 'border-destructive'}>
            {result.success ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
              <AlertCircle className="h-4 w-4 text-destructive" />
            )}
            <AlertDescription>
              <div className="space-y-2">
                <p className="font-medium">{result.message}</p>
                {result.details && (
                  <pre className="text-xs bg-muted p-2 rounded overflow-auto">
                    {JSON.stringify(result.details, null, 2)}
                  </pre>
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}