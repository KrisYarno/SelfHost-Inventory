#!/bin/bash

# Test script for mass update API without notes field
# This script uses curl to test the endpoint

echo "🧪 Testing Mass Update API (without notes field)"
echo "=================================================="
echo ""

# Test data - notice no notes field in first two items
TEST_DATA='{
  "userId": "test-user-123",
  "locationId": "test-location-456",
  "changes": [
    {
      "productId": "prod-001",
      "changeType": "increase",
      "value": 5,
      "reason": "restocking"
    },
    {
      "productId": "prod-002",
      "changeType": "decrease",
      "value": 3,
      "reason": "damaged"
    },
    {
      "productId": "prod-003",
      "changeType": "set",
      "value": 100,
      "reason": "cycle_count",
      "notes": "Monthly inventory count"
    }
  ]
}'

# Default to localhost:3000
HOST="${HOST:-localhost}"
PORT="${PORT:-3000}"
ENDPOINT="http://${HOST}:${PORT}/api/inventory/adjust"

echo "📤 Sending POST request to: $ENDPOINT"
echo ""
echo "Request body:"
echo "$TEST_DATA" | jq . 2>/dev/null || echo "$TEST_DATA"
echo ""
echo "Response:"
echo "----------"

# Make the request
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "$TEST_DATA" \
  "$ENDPOINT")

# Extract body and status
HTTP_BODY=$(echo "$RESPONSE" | sed -n '1,/^HTTP_STATUS:/p' | sed '$d')
HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)

# Pretty print the response if jq is available
echo "$HTTP_BODY" | jq . 2>/dev/null || echo "$HTTP_BODY"
echo ""
echo "Status Code: $HTTP_STATUS"
echo ""
echo "=================================================="

# Check if successful
if [ "$HTTP_STATUS" -eq 200 ] || [ "$HTTP_STATUS" -eq 201 ]; then
    echo "✅ SUCCESS: Mass update API works without notes field!"
    echo "   - The API accepted changes without the notes field"
    echo "   - Status code: $HTTP_STATUS"
else
    echo "❌ FAILED: Mass update API returned error"
    echo "   - Status code: $HTTP_STATUS"
    echo "   - Check the response body for error details"
fi

echo ""
echo "Usage:"
echo "  ./scripts/test-mass-update.sh                    # Test against localhost:3000"
echo "  HOST=example.com PORT=443 ./scripts/test-mass-update.sh  # Test against production"
echo ""