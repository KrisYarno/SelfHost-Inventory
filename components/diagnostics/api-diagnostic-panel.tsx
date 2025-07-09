'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2, CheckCircle, XCircle, AlertCircle, Play } from 'lucide-react';
import { useCSRF, withCSRFHeaders } from '@/hooks/use-csrf';

interface DiagnosticResult {
  test: string;
  status: 'success' | 'warning' | 'error' | 'pending';
  message: string;
  details?: any;
}

export function ApiDiagnosticPanel() {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<DiagnosticResult[]>([]);
  const [showDetails, setShowDetails] = useState<string | null>(null);
  const { token: csrfToken } = useCSRF();

  const runDiagnostics = async () => {
    setIsRunning(true);
    setResults([]);
    
    const tests = [
      {
        name: 'Browser Compatibility',
        fn: async () => {
          if (!window.fetch) {
            throw new Error('Fetch API not supported');
          }
          return { supported: true, userAgent: navigator.userAgent };
        }
      },
      {
        name: 'Authentication Status',
        fn: async () => {
          const response = await fetch('/api/auth/session', {
            credentials: 'same-origin'
          });
          const session = await response.json();
          if (!session?.user) {
            throw new Error('Not authenticated');
          }
          return session;
        }
      },
      {
        name: 'CSRF Token',
        fn: async () => {
          if (!csrfToken) {
            throw new Error('CSRF token not available');
          }
          // Test that we can use the token
          const response = await fetch('/api/inventory/deduct', {
            method: 'POST',
            headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
            credentials: 'same-origin',
            body: JSON.stringify({ updates: [] })
          });
          
          // Also test without CSRF token to ensure protection is working
          const unprotectedResponse = await fetch('/api/inventory/deduct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ updates: [] })
          });
          
          return {
            tokenPresent: !!csrfToken,
            tokenLength: csrfToken.length,
            protectedRequest: response.status,
            unprotectedRequest: unprotectedResponse.status,
            csrfProtectionActive: unprotectedResponse.status === 403 || unprotectedResponse.status === 401
          };
        }
      },
      {
        name: 'API Connectivity',
        fn: async () => {
          const response = await fetch('/api/products', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin'
          });
          if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
          }
          const data = await response.json();
          return { status: response.status, itemCount: data.length };
        }
      },
      {
        name: 'Mass Update Endpoint',
        fn: async () => {
          const response = await fetch('/api/inventory/deduct', {
            method: 'POST',
            headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
            credentials: 'same-origin',
            body: JSON.stringify({ updates: [] })
          });
          
          const contentType = response.headers.get('content-type');
          let data;
          
          if (contentType?.includes('application/json')) {
            data = await response.json();
          } else {
            data = await response.text();
          }
          
          if (!response.ok) {
            throw new Error(data.error || `Status ${response.status}`);
          }
          
          return { status: response.status, response: data };
        }
      },
      {
        name: 'Local Storage',
        fn: async () => {
          try {
            const testKey = 'diagnostic-test';
            localStorage.setItem(testKey, 'test');
            const value = localStorage.getItem(testKey);
            localStorage.removeItem(testKey);
            if (value !== 'test') {
              throw new Error('LocalStorage read/write failed');
            }
            return { available: true };
          } catch (error) {
            throw new Error('LocalStorage not available');
          }
        }
      },
      {
        name: 'Network Latency',
        fn: async () => {
          const start = performance.now();
          await fetch('/api/diagnostics', { method: 'HEAD' });
          const duration = performance.now() - start;
          
          if (duration > 1000) {
            throw new Error(`High latency: ${Math.round(duration)}ms`);
          }
          
          return { 
            latency: Math.round(duration),
            status: duration < 100 ? 'excellent' : duration < 300 ? 'good' : 'fair'
          };
        }
      }
    ];
    
    // Run tests sequentially
    for (const test of tests) {
      const result: DiagnosticResult = {
        test: test.name,
        status: 'pending',
        message: 'Running...',
      };
      
      setResults(prev => [...prev, result]);
      
      try {
        const testResult = await test.fn();
        setResults(prev => 
          prev.map(r => 
            r.test === test.name 
              ? { ...r, status: 'success', message: 'Passed', details: testResult }
              : r
          )
        );
      } catch (error) {
        setResults(prev => 
          prev.map(r => 
            r.test === test.name 
              ? { 
                  ...r, 
                  status: 'error', 
                  message: error instanceof Error ? error.message : 'Failed',
                  details: { error: error instanceof Error ? error.stack : error }
                }
              : r
          )
        );
      }
      
      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    setIsRunning(false);
  };

  const getStatusIcon = (status: DiagnosticResult['status']) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'warning':
        return <AlertCircle className="w-4 h-4 text-yellow-500" />;
      case 'error':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'pending':
        return <Loader2 className="w-4 h-4 animate-spin" />;
    }
  };

  const getStatusBadge = (status: DiagnosticResult['status']) => {
    const variants = {
      success: 'default',
      warning: 'secondary',
      error: 'destructive',
      pending: 'outline'
    } as const;
    
    return (
      <Badge variant={variants[status]}>
        {status === 'pending' ? 'Running' : status}
      </Badge>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Diagnostics</CardTitle>
        <CardDescription>
          Run diagnostic tests to identify issues with the mass update functionality
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <Button 
            onClick={runDiagnostics} 
            disabled={isRunning}
            className="w-full sm:w-auto"
          >
            {isRunning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running Diagnostics...
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Run Diagnostics
              </>
            )}
          </Button>
          
          {results.length > 0 && (
            <div className="space-y-2">
              {results.map((result) => (
                <div 
                  key={result.test}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                  onClick={() => setShowDetails(showDetails === result.test ? null : result.test)}
                >
                  <div className="flex items-center gap-3">
                    {getStatusIcon(result.status)}
                    <div>
                      <div className="font-medium">{result.test}</div>
                      <div className="text-sm text-gray-500">{result.message}</div>
                    </div>
                  </div>
                  {getStatusBadge(result.status)}
                </div>
              ))}
            </div>
          )}
          
          {showDetails && results.find(r => r.test === showDetails)?.details && (
            <Alert>
              <AlertDescription>
                <div className="font-mono text-xs whitespace-pre-wrap">
                  {JSON.stringify(
                    results.find(r => r.test === showDetails)?.details,
                    null,
                    2
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
          
          {results.length > 0 && !isRunning && (
            <Alert>
              <AlertDescription>
                <div className="space-y-2">
                  <div className="font-medium">Summary:</div>
                  <div className="text-sm">
                    ✅ Passed: {results.filter(r => r.status === 'success').length} | 
                    ❌ Failed: {results.filter(r => r.status === 'error').length} | 
                    ⚠️ Warnings: {results.filter(r => r.status === 'warning').length}
                  </div>
                  {results.some(r => r.status === 'error') && (
                    <div className="mt-2 text-sm">
                      <div className="font-medium">Next steps:</div>
                      <ul className="list-disc list-inside space-y-1 mt-1">
                        <li>Check browser console for detailed errors</li>
                        <li>Verify you are logged in</li>
                        <li>Check network tab in DevTools</li>
                        <li>Try refreshing the page</li>
                        {results.find(r => r.test === 'CSRF Token' && r.status === 'error') && (
                          <li className="text-red-600">CSRF token issue detected - ensure CSRF endpoint is available</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}