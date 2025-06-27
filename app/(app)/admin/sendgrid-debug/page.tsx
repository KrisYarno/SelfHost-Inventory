'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle2, Mail } from 'lucide-react';

export default function SendGridDebugPage() {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<any>(null);

  const runDebugTests = async () => {
    setIsRunning(true);
    setResults(null);
    
    try {
      const response = await fetch('/api/test/sendgrid-debug', {
        method: 'POST',
      });
      
      const data = await response.json();
      setResults(data);
    } catch (error) {
      setResults({
        error: 'Network error',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6">SendGrid Debug</h1>
      
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            SendGrid Configuration Test
          </CardTitle>
          <CardDescription>
            Run multiple tests to identify SendGrid configuration issues
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={runDebugTests}
            disabled={isRunning}
            className="w-full"
          >
            {isRunning ? 'Running Tests...' : 'Run Debug Tests'}
          </Button>
        </CardContent>
      </Card>

      {results && (
        <div className="space-y-4">
          {results.config && (
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">API Key Length:</span>
                    <span className="font-mono">{results.config.apiKeyLength || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">API Key Prefix:</span>
                    <span className="font-mono">{results.config.apiKeyPrefix || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">From Email:</span>
                    <span className="font-mono">{results.config.fromEmail}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Template ID:</span>
                    <span className="font-mono">{results.config.templateId || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">To Email:</span>
                    <span className="font-mono">{results.config.toEmail}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {results.tests && (
            <Card>
              <CardHeader>
                <CardTitle>Test Results</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {results.tests.map((test: any, index: number) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between mb-2">
                        <h4 className="font-medium">{test.test}</h4>
                        {test.success ? (
                          <CheckCircle2 className="h-5 w-5 text-success" />
                        ) : (
                          <AlertCircle className="h-5 w-5 text-destructive" />
                        )}
                      </div>
                      
                      {test.success ? (
                        <p className="text-sm text-muted-foreground">
                          Status Code: {test.statusCode}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-sm text-destructive">
                            Error: {test.error}
                          </p>
                          {test.code && (
                            <p className="text-sm text-muted-foreground">
                              Code: {test.code}
                            </p>
                          )}
                          {test.response && (
                            <pre className="text-xs bg-muted p-2 rounded overflow-auto">
                              {JSON.stringify(test.response, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {results.error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-medium">{results.error}</p>
                  {results.details && (
                    <p className="text-sm">{results.details}</p>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Common SendGrid Issues</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <div>
              <h4 className="font-medium mb-1">1. Sender Authentication</h4>
              <p className="text-muted-foreground">
                Make sure alerts@advancedresearchpep.com is verified in SendGrid under Settings → Sender Authentication
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">2. API Key Permissions</h4>
              <p className="text-muted-foreground">
                Your API key needs "Mail Send" permission. Check in SendGrid under Settings → API Keys
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">3. Template Status</h4>
              <p className="text-muted-foreground">
                Ensure your template (d-489fffae496348009b8d6b9cd6df9a2e) is Active, not Draft
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-1">4. IP Whitelisting</h4>
              <p className="text-muted-foreground">
                If you have IP access management enabled, make sure your server IP is whitelisted
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}