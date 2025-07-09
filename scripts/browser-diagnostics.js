/**
 * Browser Diagnostics Script for Mass Update Page
 * 
 * This script helps diagnose issues with the mass update functionality
 * Run this in the browser console on the mass update page
 */

(function() {
  console.log('🔍 Starting Browser Diagnostics for Mass Update Page...\n');
  
  const diagnostics = {
    timestamp: new Date().toISOString(),
    url: window.location.href,
    results: {}
  };

  // 1. Check if we're on the correct page
  function checkCurrentPage() {
    console.log('📍 Checking current page...');
    const isJournalPage = window.location.pathname.includes('/journal');
    diagnostics.results.currentPage = {
      pathname: window.location.pathname,
      isJournalPage,
      status: isJournalPage ? '✅ On journal page' : '❌ Not on journal page'
    };
    console.log(diagnostics.results.currentPage);
    return isJournalPage;
  }

  // 2. Check for React/Next.js presence
  function checkReactPresence() {
    console.log('\n⚛️ Checking React/Next.js presence...');
    const hasReact = typeof React !== 'undefined' || window.React;
    const hasNext = window.__NEXT_DATA__ !== undefined;
    const nextBuildId = window.__NEXT_DATA__?.buildId;
    
    diagnostics.results.framework = {
      hasReact,
      hasNext,
      nextBuildId,
      status: hasNext ? '✅ Next.js detected' : '❌ Next.js not detected'
    };
    console.log(diagnostics.results.framework);
  }

  // 3. Check for Content Security Policy
  function checkCSP() {
    console.log('\n🔒 Checking Content Security Policy...');
    const metaTags = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    const cspHeaders = [];
    
    metaTags.forEach(tag => {
      cspHeaders.push(tag.getAttribute('content'));
    });
    
    diagnostics.results.csp = {
      hasCSPMeta: metaTags.length > 0,
      cspPolicies: cspHeaders,
      status: cspHeaders.length > 0 ? '⚠️ CSP policies found' : '✅ No restrictive CSP meta tags'
    };
    console.log(diagnostics.results.csp);
  }

  // 4. Test fetch capability
  async function testFetchAPI() {
    console.log('\n🌐 Testing fetch API...');
    try {
      // Test basic fetch
      const testUrl = `${window.location.origin}/api/products`;
      console.log(`Testing fetch to: ${testUrl}`);
      
      const response = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin'
      });
      
      diagnostics.results.fetchTest = {
        url: testUrl,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        result: response.ok ? '✅ Fetch API works' : `⚠️ Fetch returned ${response.status}`
      };
      
      if (response.ok) {
        const data = await response.json();
        diagnostics.results.fetchTest.dataReceived = true;
        diagnostics.results.fetchTest.sampleData = data.slice(0, 1); // Just first item
      }
    } catch (error) {
      diagnostics.results.fetchTest = {
        error: error.message,
        stack: error.stack,
        result: '❌ Fetch API failed'
      };
    }
    console.log(diagnostics.results.fetchTest);
  }

  // 5. Check for CORS issues
  async function checkCORS() {
    console.log('\n🚫 Checking for CORS issues...');
    try {
      // Try to fetch from the same origin (should work)
      const sameOriginUrl = `${window.location.origin}/api/products`;
      const sameOriginResponse = await fetch(sameOriginUrl, { method: 'HEAD' });
      
      diagnostics.results.cors = {
        sameOrigin: {
          url: sameOriginUrl,
          status: sameOriginResponse.status,
          ok: sameOriginResponse.ok,
          result: sameOriginResponse.ok ? '✅ Same-origin requests work' : '❌ Same-origin failed'
        }
      };
    } catch (error) {
      diagnostics.results.cors = {
        error: error.message,
        result: '❌ CORS check failed'
      };
    }
    console.log(diagnostics.results.cors);
  }

  // 6. Check for console errors
  function checkConsoleErrors() {
    console.log('\n⚠️ Checking for console errors...');
    // Hook into console.error temporarily
    const originalError = console.error;
    const errors = [];
    
    console.error = function(...args) {
      errors.push(args.join(' '));
      originalError.apply(console, args);
    };
    
    // Restore after 100ms
    setTimeout(() => {
      console.error = originalError;
      diagnostics.results.consoleErrors = {
        count: errors.length,
        errors: errors,
        status: errors.length === 0 ? '✅ No console errors' : `❌ ${errors.length} console errors found`
      };
      console.log(diagnostics.results.consoleErrors);
    }, 100);
  }

  // 7. Check network monitor
  function setupNetworkMonitor() {
    console.log('\n📡 Setting up network monitor...');
    console.log('Network requests will be logged below. Try clicking the "Review Changes" button now.\n');
    
    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const [url, options = {}] = args;
      console.log(`📤 FETCH: ${options.method || 'GET'} ${url}`);
      if (options.body) {
        try {
          console.log('   Body:', JSON.parse(options.body));
        } catch {
          console.log('   Body:', options.body);
        }
      }
      
      return originalFetch.apply(this, args)
        .then(response => {
          console.log(`📥 RESPONSE: ${response.status} ${response.statusText} from ${url}`);
          return response;
        })
        .catch(error => {
          console.error(`❌ FETCH ERROR: ${url}`, error);
          throw error;
        });
    };
    
    // Intercept XMLHttpRequest
    const XHROpen = XMLHttpRequest.prototype.open;
    const XHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._method = method;
      this._url = url;
      return XHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
      console.log(`📤 XHR: ${this._method} ${this._url}`);
      if (body) {
        try {
          console.log('   Body:', JSON.parse(body));
        } catch {
          console.log('   Body:', body);
        }
      }
      
      this.addEventListener('load', function() {
        console.log(`📥 XHR RESPONSE: ${this.status} from ${this._url}`);
      });
      
      this.addEventListener('error', function() {
        console.error(`❌ XHR ERROR: ${this._url}`);
      });
      
      return XHRSend.apply(this, [body]);
    };
    
    diagnostics.results.networkMonitor = {
      status: '✅ Network monitor installed',
      message: 'Try clicking "Review Changes" button and watch for network requests above'
    };
    console.log(diagnostics.results.networkMonitor);
  }

  // 8. Check for specific API endpoint
  async function checkMassUpdateEndpoint() {
    console.log('\n🔌 Checking mass update endpoint...');
    const endpoint = '/api/inventory/deduct';
    const fullUrl = `${window.location.origin}${endpoint}`;
    
    try {
      // Test with OPTIONS request first (preflight)
      const optionsResponse = await fetch(fullUrl, { method: 'OPTIONS' });
      
      // Test with HEAD request
      const headResponse = await fetch(fullUrl, { method: 'HEAD' });
      
      diagnostics.results.massUpdateEndpoint = {
        endpoint,
        fullUrl,
        optionsStatus: optionsResponse.status,
        headStatus: headResponse.status,
        status: headResponse.status < 400 ? '✅ Endpoint accessible' : `❌ Endpoint returned ${headResponse.status}`
      };
    } catch (error) {
      diagnostics.results.massUpdateEndpoint = {
        endpoint,
        error: error.message,
        status: '❌ Cannot reach endpoint'
      };
    }
    console.log(diagnostics.results.massUpdateEndpoint);
  }

  // 9. Check authentication status
  async function checkAuth() {
    console.log('\n🔐 Checking authentication...');
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin'
      });
      const session = await response.json();
      
      diagnostics.results.auth = {
        hasSession: !!session?.user,
        user: session?.user?.email || 'Not authenticated',
        status: session?.user ? '✅ Authenticated' : '❌ Not authenticated'
      };
    } catch (error) {
      diagnostics.results.auth = {
        error: error.message,
        status: '❌ Auth check failed'
      };
    }
    console.log(diagnostics.results.auth);
  }

  // 10. Check for button and event listeners
  function checkReviewButton() {
    console.log('\n🔘 Checking Review Changes button...');
    const buttons = document.querySelectorAll('button');
    let reviewButton = null;
    
    buttons.forEach(btn => {
      if (btn.textContent.includes('Review Changes')) {
        reviewButton = btn;
      }
    });
    
    if (reviewButton) {
      // Check for event listeners
      const hasListeners = !!reviewButton.onclick || !!reviewButton.getAttribute('onClick');
      
      diagnostics.results.reviewButton = {
        found: true,
        disabled: reviewButton.disabled,
        hasListeners,
        className: reviewButton.className,
        status: !reviewButton.disabled ? '✅ Button found and enabled' : '⚠️ Button found but disabled'
      };
      
      // Try to get React props
      try {
        const reactKey = Object.keys(reviewButton).find(key => key.startsWith('__react'));
        if (reactKey) {
          diagnostics.results.reviewButton.hasReactHandler = true;
        }
      } catch (e) {
        // Ignore
      }
    } else {
      diagnostics.results.reviewButton = {
        found: false,
        status: '❌ Review Changes button not found'
      };
    }
    console.log(diagnostics.results.reviewButton);
  }

  // Run all diagnostics
  async function runDiagnostics() {
    console.log('==================================================');
    console.log('🏥 MASS UPDATE DIAGNOSTICS REPORT');
    console.log('==================================================\n');
    
    checkCurrentPage();
    checkReactPresence();
    checkCSP();
    await testFetchAPI();
    await checkCORS();
    checkConsoleErrors();
    await checkMassUpdateEndpoint();
    await checkAuth();
    checkReviewButton();
    setupNetworkMonitor();
    
    // Summary
    console.log('\n==================================================');
    console.log('📊 DIAGNOSTICS SUMMARY');
    console.log('==================================================');
    console.log(JSON.stringify(diagnostics, null, 2));
    
    // Copy to clipboard
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      console.log('\n📋 Diagnostics report copied to clipboard!');
    } catch (e) {
      console.log('\n📋 Copy the diagnostics object manually from above');
    }
    
    console.log('\n💡 NEXT STEPS:');
    console.log('1. Try clicking the "Review Changes" button and watch for network requests above');
    console.log('2. Check the browser DevTools Network tab for failed requests');
    console.log('3. Look for any red error messages in the console');
    console.log('4. Share the diagnostics report with the development team');
    
    return diagnostics;
  }

  // Export for manual use
  window.massUpdateDiagnostics = {
    run: runDiagnostics,
    checkNetwork: setupNetworkMonitor,
    results: diagnostics
  };

  // Auto-run
  runDiagnostics();
})();